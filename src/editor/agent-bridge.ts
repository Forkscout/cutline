/**
 * The editor tab's end of the agent bridge.
 *
 * The server relays MCP tool calls here over a WebSocket, and this turns each
 * into the same reducer action the interface would dispatch. The tab stays the
 * source of truth: edits land in the open project, in its undo stack, while
 * the user watches — never on disk behind the tab's back, where the next
 * autosave would overwrite them.
 */

import { z } from "zod";
import { listSessions } from "@/lib/media-store";
import { apiJson } from "@/lib/server";
import {
  ACTION_TOOLS,
  TAB_TOOLS,
  type ActionToolKey,
  type ArgsOf,
  type BridgeContent,
  type EditorToolKey,
  type FromTab,
  type ToTab,
} from "./agent-tools";
import { visibleClips } from "./compositor";
import { createEffect } from "./effects";
import { exportProject } from "./export";
import { audioEnvelope, describeChange, leanProject } from "./inspect";
import { wordsOnTimeline } from "./transcript";
import { readProperty } from "./keyframes";
import { importSession } from "./media";
import {
  apply,
  findClip,
  findTrack,
  mediaClip,
  projectDuration,
  shapeClip,
  textClip,
  undo,
  type Action,
  type History,
} from "./project";
import { contactSheet, renderStill } from "./snapshot";
import type { Clip, ClipRef, Project } from "./types";

/** A mistake the agent can fix, reported back to it as the tool's error. */
class ToolError extends Error {}

/* ------------------------------------------------------------ executors */

type ActionOf<K extends Action["type"]> = Extract<Action, { type: K }>;
type ToolArgs<K> = K extends ActionToolKey ? ArgsOf<(typeof ACTION_TOOLS)[K]> : never;
type Executors = {
  [K in Action["type"]]: (args: ToolArgs<K>, project: Project) => ActionOf<K> | Promise<ActionOf<K>>;
};

// Exactly one tool per reducer action, checked by the compiler: adding an
// Action variant without a tool fails here, and so does a tool with no action.
type Missing = Exclude<Action["type"], ActionToolKey>;
type Extra = Exclude<ActionToolKey, Action["type"]>;
const coverage: [Missing, Extra] extends [never, never] ? true : never = true;
void coverage;

const ref = (a: { trackId: string; clipId: string }): ClipRef => ({ trackId: a.trackId, clipId: a.clipId });

function clipOrThrow(project: Project, r: ClipRef): Clip {
  const clip = findClip(project, r);
  if (!clip) throw new ToolError(`No clip ${r.clipId} on track ${r.trackId}. get_project lists the ids.`);
  return clip;
}

const EXECUTORS: Executors = {
  addClip: (a, project) => {
    const track = findTrack(project, a.trackId);
    if (!track) throw new ToolError(`No track ${a.trackId}.`);
    let clip: Clip;
    if (a.kind === "media") {
      const asset = project.assets.find((x) => x.id === a.assetId);
      if (!asset) throw new ToolError(`No asset ${a.assetId ?? "(assetId is required)"} in this project.`);
      const wants = asset.hasVideo ? "video" : "audio";
      if (track.kind !== wants) throw new ToolError(`${asset.name} goes on a ${wants} track; ${track.name} is ${track.kind}.`);
      clip = mediaClip(asset, a.start, a.transform);
      if (a.duration) clip.duration = Math.min(a.duration, asset.durationSec || a.duration);
    } else {
      if (track.kind !== "video") throw new ToolError("Text and shape clips go on a video track.");
      clip = a.kind === "text" ? textClip(a.start, a.duration) : shapeClip(a.start, a.duration);
      if (a.text && clip.text) clip.text = { ...clip.text, ...a.text };
      if (a.shape && clip.shape) clip.shape = { ...clip.shape, ...a.shape };
      if (a.transform) clip.transform = { ...clip.transform, ...a.transform };
    }
    if (a.name) clip.name = a.name;
    return { type: "addClip", trackId: a.trackId, clip };
  },
  moveClip: (a) => ({ type: "moveClip", ref: ref(a), start: a.start, ...(a.toTrackId ? { toTrackId: a.toTrackId } : {}) }),
  trimClip: (a) => ({ type: "trimClip", ref: ref(a), edge: a.edge, time: a.time, ripple: a.ripple ?? false }),
  slipClip: (a) => ({ type: "slipClip", ref: ref(a), delta: a.delta }),
  splitClip: (a) => ({ type: "splitClip", ref: ref(a), time: a.time }),
  deleteClip: (a) => ({ type: "deleteClip", ref: ref(a) }),
  rippleDelete: (a) => ({ type: "rippleDelete", ref: ref(a) }),
  duplicateClip: (a) => ({ type: "duplicateClip", ref: ref(a) }),
  patchClip: (a) => ({ type: "patchClip", ref: ref(a), patch: a.patch }),
  detachAudio: (a) => ({ type: "detachAudio", ref: ref(a) }),
  unlinkClip: (a) => ({ type: "unlinkClip", ref: ref(a) }),
  linkClips: (a) => ({ type: "linkClips", refs: a.clips.map(ref) }),
  setTransform: (a) => ({ type: "setTransform", ref: ref(a), patch: a.patch }),
  setColor: (a) => ({ type: "setColor", ref: ref(a), patch: a.patch }),
  setText: (a) => ({ type: "setText", ref: ref(a), patch: a.patch }),
  setShape: (a) => ({ type: "setShape", ref: ref(a), patch: a.patch }),
  setMask: (a) => ({ type: "setMask", ref: ref(a), patch: a.patch }),
  setChroma: (a) => ({ type: "setChroma", ref: ref(a), patch: a.patch }),
  setTransition: (a) => ({ type: "setTransition", ref: ref(a), edge: a.edge, patch: a.patch }),
  addEffect: (a) => {
    const effect = createEffect(a.effectType);
    effect.params = { ...effect.params, ...a.params };
    return { type: "addEffect", ref: ref(a), effect };
  },
  removeEffect: (a) => ({ type: "removeEffect", ref: ref(a), effectId: a.effectId }),
  patchEffect: (a, project) => {
    const effect = clipOrThrow(project, ref(a)).effects.find((e) => e.id === a.effectId);
    if (!effect) throw new ToolError(`No effect ${a.effectId} on that clip.`);
    // Merged here, because the reducer replaces `params` wholesale and a
    // partial update would silently reset every other parameter.
    return {
      type: "patchEffect",
      ref: ref(a),
      effectId: a.effectId,
      patch: {
        ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        ...(a.params ? { params: { ...effect.params, ...a.params } } : {}),
      },
    };
  },
  reorderEffect: (a) => ({ type: "reorderEffect", ref: ref(a), effectId: a.effectId, delta: a.delta }),
  addKeyframe: (a, project) => {
    if (readProperty(clipOrThrow(project, ref(a)), a.property) === undefined) {
      throw new ToolError(`${a.property} is not a numeric property of that clip. Try transform.x, transform.scale, transform.opacity or color.exposure.`);
    }
    return {
      type: "addKeyframe",
      ref: ref(a),
      keyframe: { id: crypto.randomUUID(), property: a.property, time: a.time, value: a.value, easing: a.easing ?? "ease" },
    };
  },
  removeKeyframe: (a) => ({ type: "removeKeyframe", ref: ref(a), keyframeId: a.keyframeId }),
  patchKeyframe: (a) => ({
    type: "patchKeyframe",
    ref: ref(a),
    keyframeId: a.keyframeId,
    patch: {
      ...(a.time !== undefined ? { time: a.time } : {}),
      ...(a.value !== undefined ? { value: a.value } : {}),
      ...(a.easing ? { easing: a.easing } : {}),
    },
  }),
  addTrack: (a) => ({ type: "addTrack", kind: a.kind, ...(a.index !== undefined ? { index: a.index } : {}) }),
  deleteTrack: (a) => ({ type: "deleteTrack", trackId: a.trackId }),
  moveTrack: (a) => ({ type: "moveTrack", trackId: a.trackId, delta: a.delta }),
  patchTrack: (a) => ({ type: "patchTrack", trackId: a.trackId, patch: a.patch }),
  addMarker: (a) => ({
    type: "addMarker",
    marker: {
      id: crypto.randomUUID(),
      time: a.time,
      duration: a.duration ?? 0,
      name: a.name ?? "Agent note",
      note: a.note ?? "",
      color: a.color ?? "#c3f53c",
    },
  }),
  patchMarker: (a) => ({ type: "patchMarker", markerId: a.markerId, patch: a.patch }),
  deleteMarker: (a) => ({ type: "deleteMarker", markerId: a.markerId }),
  addAssets: async (a, project) => {
    const session = (await listSessions()).find((s) => s.id === a.sessionId);
    if (!session) throw new ToolError(`No recording ${a.sessionId}. list_recordings has the ids.`);
    const assets = (await importSession(session)).filter((x) => !project.assets.some((p) => p.id === x.id));
    if (assets.length === 0) throw new ToolError("That recording is already in the project.");
    return { type: "addAssets", assets };
  },
  patchAsset: (a) => ({ type: "patchAsset", assetId: a.assetId, patch: a.patch }),
  removeAsset: (a) => ({ type: "removeAsset", assetId: a.assetId }),
  addBin: (a) => ({ type: "addBin", name: a.name }),
  patchBin: (a) => ({ type: "patchBin", binId: a.binId, name: a.name }),
  deleteBin: (a) => ({ type: "deleteBin", binId: a.binId }),
  setCaptions: (a) => ({ type: "setCaptions", cues: a.cues.map((c) => ({ id: crypto.randomUUID(), ...c })) }),
  patchCaption: (a) => ({ type: "patchCaption", cueId: a.cueId, patch: a.patch }),
  addCaption: (a) => ({ type: "addCaption", cue: { id: crypto.randomUUID(), start: a.start, end: a.end, text: a.text } }),
  deleteCaption: (a) => ({ type: "deleteCaption", cueId: a.cueId }),
  setCaptionStyle: (a) => ({ type: "setCaptionStyle", patch: a.patch }),
  setProject: (a) => ({ type: "setProject", patch: a.patch }),
  setGuides: (a) => ({ type: "setGuides", patch: a.patch }),
};

/* ---------------------------------------------------------------- bridge */

export interface BridgeHost {
  /** The latest history, synchronously — not the last rendered one. */
  history(): History;
  /** Applies an update immediately and returns the result. */
  update(fn: (h: History) => History): History;
  playhead(): number;
  selection(): ClipRef | null;
  /** The tool running now, or null when the agent is idle. */
  onActivity(tool: string | null): void;
  /** Whether this editor is the one that saves the project, and how many have it open. */
  onLock?(holder: boolean, editors: number): void;
}

/** Edits more than this far apart start a new undo step even within a turn. */
const TURN_IDLE_MS = 5 * 60_000;
/** Without start_turn, agent edits still group, but only while they keep coming. */
const LOOSE_IDLE_MS = 60_000;

/**
 * A turn belongs to the project, not to the socket. The bridge object is
 * rebuilt whenever the editor's effect re-runs — a reconnect, a lock change, a
 * hot reload — and a turn that lived on it lost its name mid-way, splitting one
 * request into two undo steps. Found by the first real agent session.
 */
interface TurnState {
  label: string | null;
  lastAgentPresent: Project | null;
  lastAt: number;
}
const turns = new Map<string, TurnState>();
function turnFor(projectId: string): TurnState {
  let turn = turns.get(projectId);
  if (!turn) {
    turn = { label: null, lastAgentPresent: null, lastAt: 0 };
    turns.set(projectId, turn);
  }
  return turn;
}

/** One per page load. */
const PAGE_ID = crypto.randomUUID();

/**
 * Whether this page held each project, remembered across reconnects: after a
 * server restart it is what lets the editor that was saving claim the project
 * back, instead of whichever editor reconnected first.
 */
const holding = new Map<string, boolean>();

/**
 * At most one live bridge per page. React may build the editor's effect more
 * than once (StrictMode mounts twice in development; a hot reload re-runs it),
 * and two bridges in one page meant two sockets to the server, which then
 * routed calls to whichever spoke last.
 */
let live: AgentBridge | null = null;

const text = (t: string): BridgeContent => ({ type: "text", text: t });
const json = (value: unknown): BridgeContent => text(JSON.stringify(value));
const round = (n: number) => Math.round(n * 1000) / 1000;

export class AgentBridge {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1000;
  private lock = { holder: true, editors: 1 };

  constructor(
    private host: BridgeHost,
    private project: { id: string; name: string },
  ) {}

  private get turn(): TurnState {
    return turnFor(this.project.id);
  }

  start(): void {
    if (live && live !== this) live.stop();
    live = this;
    this.connect();
    window.addEventListener("focus", this.onFocus);
  }

  stop(): void {
    if (live === this) live = null;
    this.stopped = true;
    window.removeEventListener("focus", this.onFocus);
    this.ws?.close();
  }

  private onFocus = () => this.send({ type: "focus" });

  private send(message: FromTab): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/bridge`);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      // Which browser, and whether anyone can see it: when two editors hold the
      // same project, this is what tells them apart in the server's log.
      const brand = navigator.userAgent.match(/(Edg|Electron|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? "browser";
      this.send({
        type: "hello",
        pageId: PAGE_ID,
        projectId: this.project.id,
        name: this.project.name,
        where: `${brand}, ${document.visibilityState}`,
        wasHolder: holding.get(this.project.id) ?? false,
      });
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) void this.receive(JSON.parse(String(event.data)) as ToTab);
    };
    // The server restarts under `bun --watch` in development; come back when it
    // does. A close from a socket that is no longer the current one must not
    // start a second reconnect chain — that is how one page ended up with two.
    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
      window.setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }

  /** Asks the server to make this editor the one that saves. */
  takeover(): void {
    this.send({ type: "takeover" });
  }

  private async receive(message: ToTab): Promise<void> {
    if (message.type === "lock") {
      holding.set(this.project.id, message.holder);
      this.lock = { holder: message.holder, editors: message.editors };
      this.host.onLock?.(message.holder, message.editors);
      return;
    }
    this.host.onActivity(message.tool);
    try {
      this.send({ type: "result", id: message.id, ok: true, content: await this.execute(message.tool, message.args) });
    } catch (err) {
      const error =
        err instanceof z.ZodError
          ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.send({ type: "result", id: message.id, ok: false, error });
    } finally {
      this.host.onActivity(null);
    }
  }

  /** Runs one tool by its MCP name. Public so a harness can drive it directly. */
  async execute(name: string, rawArgs: unknown): Promise<BridgeContent[]> {
    const entry = TAB_TOOLS[name];
    if (!entry) throw new ToolError(`Unknown tool ${name}.`);
    // Validated again here, not only on the server: nothing reaches the
    // reducer that the schema did not accept.
    const args = z.object(entry.spec.input).parse(rawArgs ?? {});
    // The server routes only to the holder; this is the second line, for a
    // call already in flight when the hold moved.
    if ((entry.kind === "action" || entry.key === "undo") && !this.lock.holder) {
      throw new ToolError("This editor is read-only: the project is open in another editor that is saving it.");
    }
    return entry.kind === "action"
      ? this.runAction(entry.key as Action["type"], args)
      : this.runEditorTool(entry.key as EditorToolKey, args);
  }

  private async runAction(key: Action["type"], args: unknown): Promise<BridgeContent[]> {
    const executor = EXECUTORS[key] as (a: unknown, p: Project) => Action | Promise<Action>;
    const action = await executor(args, this.host.history().present);

    const now = Date.now();
    const turn = this.turn;
    const idle = turn.label ? TURN_IDLE_MS : LOOSE_IDLE_MS;
    // Coalesce only onto the agent's own last entry: if the user edited in
    // between, their edit must stay a separate step they can undo on its own.
    const continuing = turn.lastAgentPresent === this.host.history().present && now - turn.lastAt < idle;
    const label = turn.label ? `Agent: ${turn.label}` : "Agent edit";

    let before: History | null = null;
    const next = this.host.update((h) => {
      before = h;
      return apply(h, action, continuing, label);
    });
    const prior = before as History | null;
    if (!prior || next === prior) {
      throw new ToolError("Nothing changed. The ids may be wrong, or the edit was a no-op — check get_project.");
    }
    turn.lastAgentPresent = next.present;
    turn.lastAt = now;
    return [json({ ok: true, undoStep: label, ...describeChange(prior.present, next.present) })];
  }

  private async runEditorTool(key: EditorToolKey, raw: Record<string, unknown>): Promise<BridgeContent[]> {
    const project = this.host.history().present;
    switch (key) {
      case "getEditorState": {
        const sel = this.host.selection();
        const clip = sel ? findClip(project, sel) : undefined;
        return [
          json({
            projectId: project.id,
            name: project.name,
            width: project.width,
            height: project.height,
            frameRate: project.frameRate,
            duration: round(projectDuration(project)),
            playhead: round(this.host.playhead()),
            selection: sel && clip ? { ...sel, name: clip.name, kind: clip.kind, start: clip.start, duration: clip.duration } : null,
            tracks: project.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.length })),
            editorsOpen: this.lock.editors,
            lastUndoStep: this.host.history().label,
          }),
        ];
      }
      case "getProject":
        return [text(JSON.stringify(raw.full ? project : leanProject(project)))];
      case "renderFrame": {
        const time = Number(raw.time);
        const still = await renderStill(project, time, (raw.width as number | undefined) ?? 960, (raw.format as "jpeg" | "png" | undefined) ?? "jpeg");
        const layers = visibleClips(project, time)
          .filter(({ track }) => track.kind === "video")
          .map(({ track, clip }) => `${clip.name} (${clip.kind}, ${track.name})`);
        return [
          { type: "image", data: still.data, mimeType: still.mimeType },
          text(`Frame at ${time}s, ${still.width}x${still.height}. Layers, bottom first: ${layers.join(", ") || "none — background only"}.`),
        ];
      }
      case "contactSheet": {
        const start = Number(raw.start);
        const end = Number(raw.end);
        if (end <= start) throw new ToolError("end must be after start.");
        const sheet = await contactSheet(project, start, end, (raw.count as number | undefined) ?? 9);
        return [
          { type: "image", data: sheet.still.data, mimeType: sheet.still.mimeType },
          text(`Frames at ${sheet.times.map((t) => `${t}s`).join(", ")}, left to right, top to bottom.`),
        ];
      }
      case "audioEnvelope": {
        const start = Number(raw.start);
        const end = Number(raw.end);
        if (end <= start) throw new ToolError("end must be after start.");
        return [json(audioEnvelope(project, start, end, (raw.buckets as number | undefined) ?? 60))];
      }
      case "exportVideo": {
        const container = (raw.container as "mp4" | "webm" | undefined) ?? "mp4";
        const started = performance.now();
        const blob = await exportProject(project, {
          container,
          height: (raw.height as number | undefined) ?? project.height,
          frameRate: project.frameRate,
          quality: "high",
          bitrateMbps: null,
          useInOut: Boolean(raw.useInOut),
        });
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const slug = project.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";
        const name = `${slug}-${stamp}.${container}`;
        const saved = await apiJson<{ bytes: number; path: string }>(`/api/exports/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: blob,
        });
        return [
          json({
            ok: true,
            path: saved.path,
            bytes: saved.bytes,
            seconds: round(projectDuration(project)),
            renderSeconds: round((performance.now() - started) / 1000),
          }),
        ];
      }
      case "transcript": {
        const from = (raw.start as number | undefined) ?? 0;
        const to = (raw.end as number | undefined) ?? Number.POSITIVE_INFINITY;
        const words = wordsOnTimeline(project).filter((w) => w.end > from && w.start < to);
        if (words.length === 0) {
          const any = project.assets.some((a) => a.transcript);
          return [text(any ? "Nothing is said in that range." : "No transcript yet. Generate captions in the Captions panel first.")];
        }
        return [
          json({
            text: words.map((w) => w.text).join(" "),
            words: words.map((w) => ({ start: round(w.start), end: round(w.end), text: w.text })),
          }),
        ];
      }
      case "startTurn":
        this.turn.label = String(raw.instruction).slice(0, 80);
        // The next edit opens a fresh undo step rather than joining the last turn's.
        this.turn.lastAgentPresent = null;
        return [text(`Turn started. Edits until the next start_turn are one undo step: "Agent: ${this.turn.label}".`)];
      case "undo": {
        let label = "";
        const before = this.host.history();
        const after = this.host.update((h) => {
          label = h.label;
          return undo(h);
        });
        if (after === before) throw new ToolError("Nothing to undo.");
        this.turn.lastAgentPresent = null;
        return [text(`Undid "${label}".`)];
      }
    }
  }
}
