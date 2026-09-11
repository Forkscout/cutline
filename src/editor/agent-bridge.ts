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
import { capabilities, transcribe } from "@/lib/ai";
import { api, apiJson } from "@/lib/server";
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
import { clipBox, hitTest, visibleClips } from "./compositor";
import { createEffect } from "./effects";
import { exportProject } from "./export";
import { audioEnvelope, describeChange, leanProject } from "./inspect";
import { captionsForAsset, wordsOnTimeline, type Transcript } from "./transcript";
import { needsConfirming, scanNumbers } from "./facts";
import { lintScene } from "./lint";
import { listVersions, loadVersion, saveVersion } from "./persistence";
import { RECIPES, recipeById } from "./recipes";
import { applyBrandKit, applyRecipe, attachReference, type ApplyContext } from "./workspace-apply";
import { getItem, listItems } from "@/lib/workspace";
import { getAgents, type AgentPermissions } from "@/lib/agents";
import { clipAt, readProperty } from "./keyframes";
import { THEMES, brandOverrides, fontsInUse, mergeTheme, paletteOf, themeById, themeOf } from "./themes";
import { themeSheet } from "./styleframes";
import { analysisOf } from "./analyze";
import { AnchorError, compileStoryboard, resolveAnchor } from "./storyboard";
import { askClient, type ClientQuestion } from "./client-questions";
import { assetUrl } from "./media";
import { renderFrames as drawFrames } from "./snapshot";
import { loadFonts } from "@/lib/fonts";
import * as macros from "./agent-macros";
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
  type History, replaceValue } from "./project";
import { contactSheet, renderStill } from "./snapshot";
import type { Clip, ClipRef, Project, Marker, Track } from "./types";

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
      // A note pinned to the picture, and who left it: dropped here, list_notes had nothing to point at.
      ...(a.pin ? { pin: a.pin } : {}),
      ...(a.author ? { author: a.author } : {}),
      ...(a.resolved !== undefined ? { resolved: a.resolved } : {}),
      ...(a.reply ? { reply: a.reply } : {}),
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
  setBrief: (a) => {
    if (!a.patch && !a.decision) throw new ToolError("Pass a patch, a decision, or both.");
    const { references, ...patch } = a.patch ?? {};
    return {
      type: "setBrief",
      patch: {
        ...patch,
        ...(references
          ? { references: references.map((r) => ({ id: crypto.randomUUID(), assetId: r.assetId ?? null, url: r.url ?? null, note: r.note })) }
          : {}),
      },
      ...(a.decision ? { decision: a.decision } : {}),
    };
  },
  setStoryboard: (a) => {
    const scenes = new Set<string>();
    for (const scene of a.storyboard.scenes) {
      if (scenes.has(scene.id)) throw new ToolError(`Two scenes are called ${scene.id}; ids must be unique.`);
      scenes.add(scene.id);
      const components = new Set<string>();
      for (const c of scene.components) {
        if (components.has(c.id)) throw new ToolError(`Scene ${scene.id} has two components called ${c.id}.`);
        components.add(c.id);
      }
    }
    return { type: "setStoryboard", storyboard: { version: 1, ...a.storyboard, compiledAt: null } };
  },
  setFact: (a, project) => {
    const existing = project.facts.find((f) => (a.id ? f.id === a.id : f.value === a.value));
    if (a.id && !existing) throw new ToolError(`There is no fact ${a.id}; list_facts shows them.`);
    const note = a.note ?? existing?.note;
    const time = a.time ?? existing?.time;
    return {
      type: "setFact",
      fact: {
        id: existing?.id ?? crypto.randomUUID(),
        value: a.value,
        status: a.status ?? (existing?.status === "corrected" ? "confirmed" : existing?.status) ?? "open",
        source: existing?.source ?? "agent",
        ...(note ? { note } : {}),
        ...(time !== undefined ? { time } : {}),
        ...(existing?.was ? { was: existing.was } : {}),
      },
    };
  },
  correctFact: (a, project) => {
    if (a.value === a.to) throw new ToolError("The new value is the same as the one on screen.");
    const shown = project.tracks.some((t) => t.clips.some((c) => c.text && replaceValue(c.text.content, a.value, a.to) !== c.text.content));
    if (!shown) throw new ToolError(`${a.value} is not on screen as a whole value; list_facts shows the numbers on screen.`);
    const existing = project.facts.find((f) => f.value === a.value);
    return { type: "correctFact", id: existing?.id ?? crypto.randomUUID(), from: a.value, to: a.to, ...(a.note ? { note: a.note } : {}) };
  },
  restoreVersion: async (a, project) => {
    let doc: Project;
    try {
      doc = await loadVersion(project.id, a.versionId);
    } catch (err) {
      throw new ToolError(`Could not open version ${a.versionId} (${err instanceof Error ? err.message : String(err)}); list_versions shows them.`);
    }
    return { type: "restoreVersion", project: doc, label: a.versionId };
  },
  setTheme: async (a, project) => {
    const look = a.lookId ? await getItem("looks", a.lookId).catch(() => null) : null;
    if (a.lookId && !look) throw new ToolError(`There is no look ${a.lookId}; list_themes shows them.`);
    const base = look ? look.theme : a.themeId ? themeById(a.themeId) : themeOf(project);
    return { type: "setTheme", theme: mergeTheme(base, a.overrides ?? {}), restyle: a.restyle ?? true };
  },
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

/**
 * Transcriptions in flight, by asset. A long one outlasts the call that
 * started it; asking again joins the same job instead of starting another.
 */
interface Transcribing {
  promise: Promise<Transcript>;
  progress: number;
  note: string;
  service: string;
}

/**
 * What belongs to the page rather than to one bridge, or to one evaluation of
 * this module. A hot reload of this file, or of anything it imports, evaluates
 * it afresh; when these were module variables that minted a new page id (so
 * the server took the page for a stranger), forgot each project's turn (so the
 * next edit was a nameless "Agent edit" step), and stranded the answers of
 * calls still running. On globalThis they last as long as the page, and a
 * reload is a new page. Fields are filled one by one so that an edit adding a
 * field still finds it on a page that loaded before the edit.
 */
interface Page {
  /** One per page load. */
  id: string;
  turns: Map<string, TurnState>;
  /**
   * Whether this page held each project, remembered across reconnects: after a
   * server restart it is what lets the editor that was saving claim the project
   * back, instead of whichever editor reconnected first.
   */
  holding: Map<string, boolean>;
  transcribing: Map<string, Transcribing>;
  /**
   * At most one live bridge per page. React may build the editor's effect more
   * than once (StrictMode mounts twice in development; a hot reload re-runs it),
   * and two bridges in one page meant two sockets to the server, which then
   * routed calls to whichever spoke last.
   */
  live: AgentBridge | null;
  /** The live bridge's socket once it has said hello — where every answer goes. */
  socket: WebSocket | null;
  /** Answers that finished while the page had no socket, sent after the next hello. */
  outbox: FromTab[];
  /**
   * When the page was loaded or last focused. Sent with hello, because the
   * server routes calls to the editor the user touched last, and a reconnect
   * — after a restart, every editor's — is not a touch.
   */
  touchedAt: number;
}
const shared = ((globalThis as { __cutlineAgentPage?: Partial<Page> }).__cutlineAgentPage ??= {});
shared.id ??= crypto.randomUUID();
shared.turns ??= new Map();
shared.holding ??= new Map();
shared.transcribing ??= new Map();
shared.live ??= null;
shared.socket ??= null;
shared.outbox ??= [];
// The page's load time, even when a hot reload evaluates this long after it.
shared.touchedAt ??= Math.round(performance.timeOrigin);
const page = shared as Page;

function turnFor(projectId: string): TurnState {
  let turn = page.turns.get(projectId);
  if (!turn) {
    turn = { label: null, lastAgentPresent: null, lastAt: 0 };
    page.turns.set(projectId, turn);
  }
  return turn;
}

const turnName = (instruction: string) => instruction.slice(0, 80);

/**
 * Sends an answer on the socket the page has now, not the one its call came
 * in on. A call can outlive its socket — the server restarted, the bridge was
 * rebuilt — and the server keeps it pending for the page, so the answer is
 * good on the next socket too.
 */
function deliver(message: FromTab): void {
  if (page.socket?.readyState === WebSocket.OPEN) page.socket.send(JSON.stringify(message));
  else page.outbox.push(message);
}

/** How long one transcribe call waits before answering "running". The server gives a relayed call 120 s. */
const TRANSCRIBE_WAIT_MS = 90_000;

const text = (t: string): BridgeContent => ({ type: "text", text: t });
const json = (value: unknown): BridgeContent => text(JSON.stringify(value));
const round = (n: number) => Math.round(n * 1000) / 1000;


/** The track an agent's edit would change, when the user has locked it. A track's own settings stay editable. */
function lockedTrackIn(project: Project, action: Action): Track | null {
  if (action.type === "patchTrack") return null;
  const named = action as { ref?: ClipRef; refs?: ClipRef[]; trackId?: string; toTrackId?: string };
  const ids = new Set<string>();
  if (named.ref) ids.add(named.ref.trackId);
  for (const ref of named.refs ?? []) ids.add(ref.trackId);
  if (named.trackId) ids.add(named.trackId);
  if (named.toTrackId) ids.add(named.toTrackId);
  return project.tracks.find((t) => t.locked && ids.has(t.id)) ?? null;
}

/** What is under a note's pin at its moment, topmost first — from clipBox, as the handles are. */
function underPin(project: Project, marker: Marker) {
  if (!marker.pin) return [];
  const x = marker.pin.x * project.width;
  const y = marker.pin.y * project.height;
  const hits: { track: Track; clip: Clip }[] = [];
  let baseTaken = false;
  for (const { track, clip: raw } of visibleClips(project, marker.time)) {
    if (track.kind !== "video") continue;
    const clip = clipAt(raw, marker.time - raw.start);
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (clip.kind === "media" && !asset?.hasVideo) continue;
    const isBase = clip.kind === "media" && !baseTaken;
    if (isBase) baseTaken = true;
    const box = clipBox(project, clip, asset ? { width: asset.width, height: asset.height } : null, isBase);
    if (box && hitTest(box, x, y)) hits.push({ track, clip: raw });
  }
  return hits.reverse().map(({ track, clip }) => ({
    trackId: track.id,
    clipId: clip.id,
    kind: clip.kind,
    ...(clip.text?.content ? { text: clip.text.content.slice(0, 80) } : {}),
    ...(clip.scene ? { scene: clip.scene } : {}),
    ...(clip.component ? { component: clip.component } : {}),
  }));
}

/**
 * What agents may do, as the user set it. The server refuses an export or an
 * import it may not make; whether a clip was the agent's to delete is a
 * question only the tab can answer, so it is answered here. Read again every
 * half minute: a change in Settings should take effect without a reload.
 */
let permissions: AgentPermissions = { mayExport: true, mayImport: true, mayDeleteOthersClips: true };
let permissionsAt = 0;

async function currentPermissions(): Promise<AgentPermissions> {
  if (Date.now() - permissionsAt < 30_000) return permissions;
  permissionsAt = Date.now();
  permissions = await getAgents()
    .then((view) => view.permissions)
    .catch(() => permissions);
  return permissions;
}

export class AgentBridge {
  private ws: WebSocket | null = null;
  private stopped = false;
  private failures = 0;
  private lock = { holder: true, editors: 1 };

  constructor(
    private host: BridgeHost,
    private project: { id: string; name: string },
  ) {}

  private get turn(): TurnState {
    return turnFor(this.project.id);
  }

  start(): void {
    if (page.live && page.live !== this) page.live.stop();
    page.live = this;
    this.connect();
    window.addEventListener("focus", this.onFocus);
  }

  stop(): void {
    if (page.live === this) page.live = null;
    if (page.socket === this.ws) page.socket = null;
    this.stopped = true;
    window.removeEventListener("focus", this.onFocus);
    this.ws?.close();
  }

  /**
   * The bridge serving this project now: this one, unless a call outlived it —
   * the editor's effect re-ran, or a hot reload rebuilt the bridge, while an
   * import or a transcription was under way. Its edit belongs in the editor as
   * it is now; if no bridge serves this project, the editor has closed.
   */
  private current(): AgentBridge {
    if (!this.stopped) return this;
    if (page.live && page.live.project.id === this.project.id) return page.live;
    throw new ToolError("The editor closed before the edit landed.");
  }

  private onFocus = () => {
    page.touchedAt = Date.now();
    this.send({ type: "focus" });
  };

  private send(message: FromTab): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/bridge`);
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      // Which browser, and whether anyone can see it: when two editors hold the
      // same project, this is what tells them apart in the server's log.
      const brand = navigator.userAgent.match(/(Edg|Electron|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? "browser";
      this.send({
        type: "hello",
        pageId: page.id,
        projectId: this.project.id,
        name: this.project.name,
        where: `${brand}, ${document.visibilityState}`,
        wasHolder: page.holding.get(this.project.id) ?? false,
        touchedAt: page.touchedAt,
      });
      // After hello, so the server knows the page they come from.
      page.socket = ws;
      for (const message of page.outbox.splice(0)) ws.send(JSON.stringify(message));
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) void this.receive(JSON.parse(String(event.data)) as ToTab);
    };
    // The server restarts under `bun --watch` in development; come back when it
    // does. A close from a socket that is no longer the current one must not
    // start a second reconnect chain — that is how one page ended up with two.
    ws.onclose = () => {
      if (page.socket === ws) page.socket = null;
      if (this.stopped || this.ws !== ws) return;
      // Every second for the first few tries — a restart takes about one, and
      // the server waits a few seconds for the editors before it routes a call
      // — then backing off to every ten.
      window.setTimeout(() => this.connect(), Math.min(1000 * 2 ** Math.max(0, this.failures - 2), 10_000));
      this.failures += 1;
    };
  }

  /** Asks the server to make this editor the one that saves. */
  takeover(): void {
    this.send({ type: "takeover" });
  }

  private async receive(message: ToTab): Promise<void> {
    if (message.type === "lock") {
      page.holding.set(this.project.id, message.holder);
      this.lock = { holder: message.holder, editors: message.editors };
      this.host.onLock?.(message.holder, message.editors);
      return;
    }
    if (message.turn !== undefined) this.adopt(message.turn);
    this.host.onActivity(message.tool);
    try {
      deliver({ type: "result", id: message.id, ok: true, content: await this.execute(message.tool, message.args) });
    } catch (err) {
      const error =
        err instanceof z.ZodError
          ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`
          : err instanceof Error
            ? err.message
            : String(err);
      deliver({ type: "result", id: message.id, ok: false, error });
    } finally {
      this.host.onActivity(null);
    }
  }

  /**
   * Takes the turn the server names with each call. It differs from this
   * page's own only when the page lost it (a reload) or never saw start_turn
   * (the hold moved here from another editor); either way the next edit opens
   * a step under the turn's name rather than a nameless one.
   */
  private adopt(instruction: string): void {
    const label = turnName(instruction);
    if (label === this.turn.label) return;
    this.turn.label = label;
    this.turn.lastAgentPresent = null;
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
    if ((entry.key === "deleteClip" || entry.key === "rippleDelete") && !(await currentPermissions()).mayDeleteOthersClips) {
      // Nothing records which agent made a clip, but a clip an agent made
      // carries its scene, its component or its role. The rest are the user's.
      const ref = (args as { ref?: ClipRef }).ref;
      const clip = ref ? findClip(this.host.history().present, ref) : undefined;
      if (clip && !clip.scene && !clip.component && !clip.role) {
        throw new ToolError(
          "This clip was not made by an agent, and deleting the user's own clips is turned off in Settings › Agents. Ask them to delete it, or to turn it on.",
        );
      }
    }
    return entry.kind === "action"
      ? this.runAction(entry.key as Action["type"], args)
      : this.runEditorTool(entry.key as EditorToolKey, args);
  }

  private async runAction(key: Action["type"], args: unknown): Promise<BridgeContent[]> {
    const executor = EXECUTORS[key] as (a: unknown, p: Project) => Action | Promise<Action>;
    const action = await executor(args, this.host.history().present);
    const { label, change } = this.commit(action);
    return [json({ ok: true, undoStep: label, ...change })];
  }

  /** Applies an action as the agent's edit, joining the turn's undo step. */
  /** Runs a macro against the live project; every clip it makes is committed inside the agent's turn. */
  private async macro<T>(run: (ctx: macros.MacroContext) => T): Promise<T> {
    // Text is measured in the faces it will be drawn in, so they load first.
    await loadFonts(fontsInUse(this.host.history().present)).catch(() => []);
    const ctx: macros.MacroContext = {
      project: () => this.host.history().present,
      commit: (action) => void this.commit(action),
      measure: macros.measureOnCanvas,
    };
    try {
      return run(ctx);
    } catch (err) {
      if (err instanceof macros.MacroError) throw new ToolError(err.message);
      throw err;
    }
  }

  /** The live project and the agent's commit, for applying workspace items inside the turn. */
  private get workspace(): ApplyContext {
    return { project: () => this.host.history().present, commit: (action) => void this.commit(action) };
  }

  private commit(action: Action): { label: string; change: ReturnType<typeof describeChange> } {
    const bridge = this.current();
    if (bridge !== this) return bridge.commit(action);
    // A track the user locked is theirs: an agent's edit to it is refused, not applied.
    const locked = lockedTrackIn(this.host.history().present, action);
    if (locked) {
      throw new ToolError(`Track ${locked.name} is locked — the user locked it so nothing on it changes. Ask them to unlock it, or work on another track.`);
    }
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
    return { label, change: describeChange(prior.present, next.present) };
  }

  /**
   * Puts a finished transcript on its asset as the agent's edit, and the
   * captions made from it when asked. Runs when the transcription finishes,
   * which may be after the call that started it has answered "running".
   */
  private store(assetId: string, transcript: Transcript, withCaptions: boolean): void {
    try {
      const bridge = this.current();
      if (!bridge.lock.holder) return;
      bridge.commit({ type: "patchAsset", assetId, patch: { transcript } });
      if (withCaptions) {
        const project = bridge.host.history().present;
        bridge.commit({ type: "setCaptions", cues: captionsForAsset(project, assetId, transcript).cues });
        if (!project.captionsEnabled) bridge.commit({ type: "setProject", patch: { captionsEnabled: true } });
      }
    } catch {
      // The project closed or the asset went away meanwhile. The transcript
      // is cached beside the file, so the next call finds it at once.
    }
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
          return [text(any ? "Nothing is said in that range." : "No transcript yet. Call transcribe with the asset id of a clip with sound.")];
        }
        return [
          json({
            text: words.map((w) => w.text).join(" "),
            words: words.map((w) => ({ start: round(w.start), end: round(w.end), text: w.text })),
          }),
        ];
      }
      case "layoutMove":
        return [json(await this.macro((ctx) => macros.layoutMove(ctx, raw as unknown as macros.LayoutMoveArgs)))];
      case "addTitle":
        return [json(await this.macro((ctx) => macros.addTitle(ctx, raw as unknown as macros.TitleArgs)))];
      case "addPoints":
        return [json(await this.macro((ctx) => macros.addPoints(ctx, raw as unknown as macros.PointsArgs)))];
      case "addChips":
        return [json(await this.macro((ctx) => macros.addChips(ctx, raw as unknown as macros.ChipsArgs)))];
      case "addStat":
        return [json(await this.macro((ctx) => macros.addStat(ctx, raw as unknown as macros.StatArgs)))];
      case "addFlow":
        return [json(await this.macro((ctx) => macros.addFlow(ctx, raw as unknown as macros.FlowArgs)))];
      case "addBars":
        return [json(await this.macro((ctx) => macros.addBars(ctx, raw as unknown as macros.BarsArgs)))];
      case "addLowerThird":
        return [json(await this.macro((ctx) => macros.addLowerThird(ctx, raw as unknown as macros.LowerThirdArgs)))];
      case "addStatement":
        return [json(await this.macro((ctx) => macros.addStatement(ctx, raw as unknown as macros.StatementArgs)))];
      case "addTally":
        return [json(await this.macro((ctx) => macros.addTally(ctx, raw as unknown as macros.TallyArgs)))];
      case "addCards":
        return [json(await this.macro((ctx) => macros.addCards(ctx, raw as unknown as macros.CardsArgs)))];
      case "addSplit":
        return [json(await this.macro((ctx) => macros.addSplit(ctx, raw as unknown as macros.SplitArgs)))];
      case "addTree":
        return [json(await this.macro((ctx) => macros.addTree(ctx, raw as unknown as macros.TreeArgs)))];
      case "listBrandKits":
        return [
          json(
            (await listItems("brand-kits")).map((k) => ({
              id: k.id, name: k.name, version: k.version, colors: k.colors, fonts: k.fonts, tone: k.tone,
              rules: k.rules, layout: k.layout, lowerThird: k.lowerThird, files: k.files, notes: k.notes,
            })),
          ),
        ];
      case "applyBrandKit": {
        const kit = await getItem("brand-kits", String(raw.id)).catch(() => null);
        if (!kit) throw new ToolError(`There is no brand kit ${String(raw.id)}; list_brand_kits shows them.`);
        const done = await applyBrandKit(this.workspace, kit);
        return [json({ ok: true, kit: kit.name, version: kit.version, copiedIn: done.copiedIn, notes: done.notes, next: "render_frame a scene to see the restyle." })];
      }
      case "listRecipes": {
        const saved = await listItems("recipes").catch(() => []);
        return [
          json(
            [...RECIPES, ...saved].map((r) => ({
              id: r.id, name: r.name, description: r.description, builtIn: Boolean(r.builtIn),
              brief: r.brief, questions: r.questions, patterns: r.patterns, qa: r.qa, exports: r.exports,
            })),
          ),
        ];
      }
      case "applyRecipe": {
        const recipe = recipeById(String(raw.id)) ?? (await getItem("recipes", String(raw.id)).catch(() => null));
        if (!recipe) throw new ToolError(`There is no recipe ${String(raw.id)}; list_recipes shows them.`);
        applyRecipe(this.workspace, recipe);
        return [json({ ok: true, recipe: recipe.name, ask: recipe.questions, patterns: recipe.patterns, qa: recipe.qa, exports: recipe.exports })];
      }
      case "listReferences": {
        const tag = typeof raw.tag === "string" ? raw.tag.toLowerCase() : null;
        const refs = await listItems("references");
        return [
          json(
            refs
              .filter((r) => !tag || r.tags.some((t) => t.toLowerCase() === tag))
              .map((r) => ({ id: r.id, name: r.name, url: r.url, file: r.file ?? null, note: r.note, tags: r.tags })),
          ),
        ];
      }
      case "attachReference": {
        const ref = await getItem("references", String(raw.id)).catch(() => null);
        if (!ref) throw new ToolError(`There is no reference ${String(raw.id)}; list_references shows them.`);
        const done = await attachReference(this.workspace, ref, typeof raw.note === "string" ? raw.note : undefined);
        return [json({ ok: true, reference: ref.name, notes: done.notes })];
      }
      case "saveVersion": {
        const saved = await saveVersion(project, String(raw.label));
        return [json({ ok: true, ...saved, next: "restore_version({ versionId }) puts it back." })];
      }
      case "listVersions":
        return [json(await listVersions(project.id))];
      case "listNotes": {
        const notes = project.markers.filter((m) => (m.note.trim() || m.pin) && (raw.all === true || !m.resolved));
        return [
          json(
            notes.map((m) => ({
              id: m.id,
              time: round(m.time),
              note: m.note,
              author: m.author ?? "client",
              resolved: Boolean(m.resolved),
              ...(m.reply ? { reply: m.reply } : {}),
              ...(m.pin ? { pin: m.pin, under: underPin(project, m) } : {}),
            })),
          ),
        ];
      }
      case "resolveNote": {
        const marker = project.markers.find((m) => m.id === raw.id);
        if (!marker) throw new ToolError(`There is no note ${String(raw.id)}; list_notes shows them.`);
        this.commit({ type: "patchMarker", markerId: marker.id, patch: { resolved: true, reply: String(raw.reply), color: "#71717A" } });
        return [json({ ok: true, id: marker.id })];
      }
      case "lintScene": {
        let report;
        try {
          report = await lintScene(project, {
            ...(typeof raw.scene === "string" ? { scene: raw.scene } : {}),
            ...(typeof raw.from === "number" ? { from: raw.from } : {}),
            ...(typeof raw.to === "number" ? { to: raw.to } : {}),
            contrast: raw.contrast !== false,
          });
        } catch (err) {
          throw new ToolError(err instanceof Error ? err.message : String(err));
        }
        const errors = report.issues.filter((i) => i.severity === "error").length;
        return [
          json({
            ...report,
            issues: report.issues.slice(0, 60),
            ...(report.issues.length > 60 ? { more: report.issues.length - 60 } : {}),
            summary: report.issues.length ? `${errors} errors, ${report.issues.length - errors} warnings` : "clean",
          }),
        ];
      }
      case "listFacts": {
        const numbers = scanNumbers(project);
        const onScreen = new Set(numbers.flatMap((n) => (n.fact ? [n.fact.id] : [])));
        const toConfirm = [
          ...numbers.filter(needsConfirming).map((n) => ({
            value: n.value,
            shownAt: n.shown.map((x) => round(x.start)),
            text: n.shown[0]!.text.slice(0, 120),
            heardNearby: n.heard,
            heard: n.excerpt,
            ...(n.fact ? { factId: n.fact.id, note: n.fact.note } : {}),
          })),
          // Flagged by an agent but not a number on screen: a name, say.
          ...project.facts
            .filter((f) => f.status === "open" && !onScreen.has(f.id))
            .map((f) => ({ value: f.value, factId: f.id, note: f.note, ...(f.time !== undefined ? { shownAt: [f.time] } : {}) })),
        ];
        return [
          json({
            toConfirm,
            recorded: project.facts,
            numbersOnScreen: numbers.length,
            heardNearby: numbers.filter((n) => n.heard).length,
            next: toConfirm.length
              ? "Ask the client about each (ask_client), then set_fact({ value, status: \"confirmed\" }) or correct_fact({ value, to })."
              : "Nothing needs confirming.",
          }),
        ];
      }
      case "getStoryboard": {
        const board = project.storyboard;
        if (!board) return [text("No storyboard yet. set_storyboard writes one; guide('storyboard') has the format.")];
        const words = wordsOnTimeline(project);
        let cursor = 0;
        const times = board.scenes.map((scene) => {
          try {
            const from = resolveAnchor(scene.from, words, cursor);
            const to = resolveAnchor(scene.to, words, from + 0.01);
            cursor = from;
            return { id: scene.id, from: round(from), to: round(to), locked: Boolean(scene.locked) };
          } catch (err) {
            return { id: scene.id, error: err instanceof AnchorError ? err.message : String(err) };
          }
        });
        return [json({ storyboard: board, times, compiledAt: board.compiledAt })];
      }
      case "setScene": {
        const scene = raw.scene as import("./types").StoryScene;
        const board = project.storyboard ?? { version: 1 as const, scenes: [], compiledAt: null };
        const exists = board.scenes.some((s) => s.id === scene.id);
        let scenes = exists ? board.scenes.map((s) => (s.id === scene.id ? scene : s)) : [...board.scenes];
        if (!exists) {
          const after = raw.after ? scenes.findIndex((s) => s.id === raw.after) : -1;
          if (raw.after && after < 0) throw new ToolError(`No scene ${String(raw.after)} to put it after.`);
          scenes = after >= 0 ? [...scenes.slice(0, after + 1), scene, ...scenes.slice(after + 1)] : [...scenes, scene];
        }
        const { change } = this.commit({ type: "setStoryboard", storyboard: { ...board, scenes } });
        void change;
        return [json({ ok: true, scene: scene.id, replaced: exists, scenes: scenes.length, next: `compile_storyboard({ only: ["${scene.id}"] })` })];
      }
      case "compileStoryboard":
        return [json(await this.macro((ctx) => compileStoryboard(ctx, raw.only ? { only: raw.only as string[] } : {})))];
      case "addBackdrop":
        return [json(await this.macro((ctx) => macros.addBackdrop(ctx, raw as unknown as macros.BackdropArgs)))];
      case "previewThemes": {
        const ids = (raw.themes as string[] | undefined) ?? THEMES.map((t) => t.id);
        const sheet = await themeSheet(project, Number(raw.time), ids.map((id) => themeById(id)), (raw.width as number | undefined) ?? 480);
        return [
          { type: "image", data: sheet.data, mimeType: sheet.mimeType },
          text(`Frame at ${raw.time}s in ${sheet.themes.map((t, i) => `${i + 1}. ${t.name} (${t.id})`).join(", ")}. Nothing was changed; set_theme applies one.`),
        ];
      }
      case "themeFromMedia": {
        const asset = project.assets.find((a) => a.id === raw.assetId);
        if (!asset) throw new ToolError(`No asset ${String(raw.assetId)}. Import the logo or reference first; get_project lists assets.`);
        if (!asset.hasVideo) throw new ToolError(`${asset.name} has no picture.`);
        let pixels: Uint8ClampedArray;
        const read = (source: CanvasImageSource, w: number, h: number) => {
          const canvas = new OffscreenCanvas(96, Math.max(1, Math.round((96 * h) / w)));
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        if (asset.kind === "image") {
          const response = await api(assetUrl(asset));
          const bitmap = await createImageBitmap(await response.blob());
          pixels = read(bitmap, bitmap.width, bitmap.height);
          bitmap.close();
        } else {
          // Just that file, full frame: a project of one clip, drawn as the export would.
          const alone: Project = {
            ...project,
            background: { type: "transparent" },
            padding: 0,
            captionsEnabled: false,
            tracks: [{ ...project.tracks.find((t) => t.kind === "video")!, clips: [{ ...mediaClip(asset, 0), transform: { ...mediaClip(asset, 0).transform } }] }],
          };
          const [frame] = await drawFrames(alone, [Math.min(Number(raw.time ?? 1), Math.max(0, asset.durationSec - 0.05))], 320);
          if (!frame) throw new ToolError("Could not draw that frame.");
          pixels = read(frame, frame.width, frame.height);
        }
        const base = raw.base ? themeById(String(raw.base)) : themeOf(project);
        const proposal = brandOverrides(paletteOf(pixels), base);
        return [
          json({
            base: base.id,
            palette: proposal.palette,
            accent: proposal.accent,
            contrastOnBackground: proposal.contrast,
            overrides: proposal.overrides,
            notes: proposal.notes,
            next: Object.keys(proposal.overrides).length
              ? `set_theme({ themeId: "${base.id.replace(/-custom$/, "")}", overrides }) applies it; preview_themes shows it first.`
              : "Nothing to change.",
          }),
        ];
      }
      case "analyzeMedia": {
        const asset = project.assets.find((a) => a.id === raw.assetId);
        if (!asset) throw new ToolError(`No asset ${String(raw.assetId)}. get_project lists them.`);
        const job = analysisOf(asset);
        const done = await Promise.race([job.promise, new Promise<null>((r) => setTimeout(() => r(null), TRANSCRIBE_WAIT_MS))]);
        if (!done) return [json({ status: "running", progress: round(job.progress), next: "Call analyze_media again with the same assetId to keep waiting." })];
        return [json({ status: "done", ...done })];
      }
      case "askClient": {
        const asked = raw.questions as { question: string; options?: string[]; multiple?: boolean; suggested?: string; why?: string }[];
        const questions: ClientQuestion[] = asked.map((q, i) => ({
          id: `q${i + 1}`,
          question: q.question,
          kind: q.options?.length ? (q.multiple ? "multi" : "choice") : "text",
          options: q.options ?? [],
          suggested: q.suggested ?? null,
          why: q.why ?? null,
        }));
        const pending = askClient(String(raw.title ?? "A few questions before I start"), questions);
        const done = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), TRANSCRIBE_WAIT_MS))]);
        if (!done) return [json({ status: "waiting", next: "The form is open in the editor. Call ask_client again with the same questions to keep waiting." })];
        if (done.status === "declined") {
          return [json({ status: "declined", next: "They closed the form. Ask in chat, or go with your suggested answers and say that you did." })];
        }
        return [
          json({
            status: "answered",
            answers: questions.map((q) => ({ question: q.question, answer: done.answers[q.id] ?? null })),
            next: "Record what matters with set_brief.",
          }),
        ];
      }
      case "getBrief": {
        const b = project.brief;
        const unanswered = [
          !b.goal && "goal — what should the video achieve, for whom?",
          !b.audience && "audience",
          !b.platform && "platform — where will it be watched (sets aspect ratio and pace)?",
          !b.layout && "layout — speaker in a side panel, full-frame B-roll cutaways, picture-in-picture, or lower-thirds only?",
          !b.tone && "tone",
          !b.brand.name && !b.brand.logoAssetId && b.brand.colors.length === 0 && "brand — a logo, colours or fonts to follow?",
          b.references.length === 0 && "references — a video or design whose look they like?",
          !b.language && "language of the words on screen",
          b.captions === null && "captions — wanted, and in which language?",
          !project.theme && "theme — show preview_themes and let them choose",
        ].filter(Boolean);
        return [
          json({
            brief: b,
            theme: project.theme,
            unanswered,
            next: unanswered.length
              ? "Ask the client about these before building; guide('brief') has the questions and sensible defaults. Record answers with set_brief."
              : "The brief is complete. Build to it, and log decisions with set_brief({ decision }).",
          }),
        ];
      }
      case "transcribe": {
        const assetId = String(raw.assetId);
        const asset = project.assets.find((a) => a.id === assetId);
        if (!asset) throw new ToolError(`No asset ${assetId} in this project. get_project lists them.`);
        if (!asset.hasAudio) throw new ToolError(`${asset.name} has no sound to transcribe.`);
        let job = page.transcribing.get(asset.id);
        if (!job) {
          const route = (await capabilities().catch(() => ({ transcribe: null }))).transcribe;
          if (!route) {
            throw new ToolError(
              "No speech-to-text service is connected. Ask the user to connect one in the Captions panel: a whisper.cpp server on this machine, or OpenAI, Groq, OpenRouter or ElevenLabs with a key.",
            );
          }
          const target =
            asset.origin.type === "recording"
              ? { sessionId: asset.origin.sessionId, fileName: asset.origin.fileName }
              : { mediaId: asset.id };
          const withCaptions = Boolean(raw.captions);
          const entry: Transcribing = {
            promise: Promise.resolve(null as unknown as Transcript),
            progress: 0,
            note: "starting",
            service: `${route.name} · ${route.model}${route.local ? " · on this machine" : ""}`,
          };
          entry.promise = transcribe(
            target,
            { ...(raw.language ? { language: String(raw.language) } : {}), ...(raw.force ? { force: true } : {}) },
            (fraction, note) => {
              entry.progress = fraction;
              entry.note = note;
            },
          )
            .then((t) => {
              // Lands through whichever bridge serves the project by then.
              this.store(asset.id, t, withCaptions);
              return t;
            })
            .finally(() => page.transcribing.delete(asset.id));
          page.transcribing.set(asset.id, entry);
          job = entry;
        }
        const done = await Promise.race([
          job.promise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), TRANSCRIBE_WAIT_MS)),
        ]);
        if (!done) {
          return [
            json({
              status: "running",
              progress: round(job.progress),
              note: job.note,
              service: job.service,
              next: "Call transcribe again with the same assetId to keep waiting on this job.",
            }),
          ];
        }
        return [
          json({
            status: "done",
            asset: asset.name,
            words: done.words.length,
            language: done.language,
            timing: done.timing,
            service: `${done.provider} · ${done.model}`,
            next: "Read it with transcript.",
          }),
        ];
      }
      case "startTurn":
        this.turn.label = turnName(String(raw.instruction));
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
