/**
 * The Director: the agent loop that runs inside the editor tab.
 *
 * It calls the same executors an MCP agent reaches through the bridge —
 * `AgentBridge.execute`, one tool by its MCP name — so there is one set of
 * tools, validated one way, whoever drives them. Its model calls go through
 * the server, which holds the key (`/api/ai/chat`), exactly as transcription
 * does. MCP stays for people who bring their own agent; this is for everyone
 * else, with nothing to install.
 *
 * No React in here. The panel subscribes to a snapshot
 * (useSyncExternalStore), and the loop outlives any render.
 */

import { z } from "zod";
import { chat } from "@/lib/ai";
import type { ChatBlock, ChatMessage, ChatTool, ToolResultBlock, ToolUseBlock } from "@/lib/chat-protocol";
import { GUIDE, GUIDE_TOPICS, guideIndex } from "./agent-guide";
import { SERVER_INSTRUCTIONS, TAB_TOOLS, type BridgeContent, type Shape } from "./agent-tools";
import { THEMES } from "./themes";
import { listItems } from "@/lib/workspace";

export const PHASES = ["Brief", "Source", "Treatment", "Styleframe", "Build", "Review", "Deliver"] as const;
export type Phase = (typeof PHASES)[number];

export type ThreadItem =
  | { kind: "user"; text: string; at: number }
  | { kind: "director"; text: string; at: number }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "ok" | "error"; detail?: string; image?: string; at: number }
  | { kind: "note"; text: string; tone: "info" | "error"; at: number };

export interface DirectorUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  calls: number;
}

export interface DirectorState {
  items: ThreadItem[];
  running: boolean;
  phase: Phase | null;
  doing: string | null;
  usage: DirectorUsage;
}

export interface DirectorHost {
  /** Runs one tool by its MCP name, as the bridge does for an MCP agent. */
  execute(name: string, args: unknown): Promise<BridgeContent[]>;
  /** The tool running now, or null: the same badge an MCP agent's calls light. */
  onActivity(tool: string | null): void;
  /** The service this project uses for its model, when it names one. */
  chatProvider?(): string | undefined;
}

/** Model calls per request before the Director stops and asks to go on. */
const MAX_STEPS = 60;
/** Tool output past this is cut: get_project on a long edit runs to a megabyte. */
const MAX_RESULT_CHARS = 16_000;
/** Frames are the heaviest thing in the conversation; older ones become a line of text. */
const KEEP_IMAGES = 3;
/** Past this many messages the oldest go, at a point where no tool call is cut from its result. */
const MAX_MESSAGES = 160;
const KEEP_MESSAGES = 100;

const ZERO: DirectorUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0 };

const ADDENDUM = `You are Cutline's Director, running inside the editor's own Director panel: the user reads your replies there and watches every edit land.

- start_turn has already been called with the user's request; do not call it.
- Call report_progress({ phase, doing }) when you move to a new phase of guide('workflow') or start something that takes a while, so the panel shows where you are.
- Keep replies short and concrete: what you did, what you saw, what you need. No preamble.
- At a checkpoint, ask in your reply and stop; the user answers in the panel. ask_client shows a form with your suggested answers when there are several questions.
- Never invent numbers or names: say which ones the transcript left uncertain.`;

const SYSTEM = `${SERVER_INSTRUCTIONS}\n\n${ADDENDUM}`;

/* ------------------------------------------------------------ tools */

/** Tools the panel answers itself: the playbook, the looks, and where the Director is. */
const LOCAL_TOOLS: Record<string, { description: string; input: Shape }> = {
  guide: {
    description: `How to work in Cutline as a director: the workflow and its checkpoints, what to ask the client, what to check in the source, layouts, themes, graphics, storyboards, review, and the gotchas. Call with no topic for the index. Topics: ${GUIDE_TOPICS.join(", ")}.`,
    input: { topic: z.enum(GUIDE_TOPICS as [string, ...string[]]).optional() },
  },
  list_themes: {
    description: "The built-in design themes: what each is for, its palette, faces and motion. Show them on the video with preview_themes; choose with set_theme.",
    input: {},
  },
  report_progress: {
    description: "Shows the user where you are: the phase of the workflow and what you are doing, in a few words. Call it when you move to a new phase or start something long.",
    input: { phase: z.enum(PHASES), doing: z.string().max(120) },
  },
};

function schemaOf(shape: Shape): Record<string, unknown> {
  try {
    const { $schema: _dropped, ...schema } = z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    return schema;
  } catch {
    // The tab validates every call anyway; an open schema only loses the hints.
    return { type: "object" };
  }
}

let toolList: ChatTool[] | null = null;

/** Every tool an MCP agent has but start_turn, which the Director calls itself, and the panel's own. */
function tools(): ChatTool[] {
  toolList ??= [
    ...Object.values(TAB_TOOLS)
      .filter(({ spec }) => spec.name !== "start_turn")
      .map(({ spec }) => ({ name: spec.name, description: spec.description, inputSchema: schemaOf(spec.input) })),
    ...Object.entries(LOCAL_TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: schemaOf(t.input) })),
  ];
  return toolList;
}

const text = (t: string): BridgeContent => ({ type: "text", text: t });

const describeError = (err: unknown): string =>
  err instanceof z.ZodError
    ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`
    : err instanceof Error
      ? err.message
      : String(err);

const clip = (t: string) =>
  t.length > MAX_RESULT_CHARS
    ? `${t.slice(0, MAX_RESULT_CHARS)}\n…(cut at ${MAX_RESULT_CHARS} of ${t.length} characters — ask for less: one track, one scene, a time range)`
    : t;

/** A few words about a call's arguments, for the thread: its time, and its first piece of text. */
function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const time = ["time", "at", "start"].map((k) => o[k]).find((v): v is number => typeof v === "number");
  const words = Object.values(o).find((v): v is string => typeof v === "string" && v.trim().length > 0);
  return [time !== undefined ? `${time.toFixed(1)} s` : "", words ? `“${words.slice(0, 48)}”` : ""].filter(Boolean).join(" · ");
}

const stopped = (use: ToolUseBlock): ToolResultBlock => ({
  type: "tool_result",
  toolUseId: use.id,
  content: [{ type: "text", text: "Not run: the user pressed Stop." }],
  isError: true,
});

/* ------------------------------------------------------------ storage */

/**
 * The thread as the user saw it, per project, in this browser. Not the
 * conversation itself: frames and tool output would fill the storage the
 * editor's crash recovery also lives in. After a reload what was said is
 * handed back to the model as context, and it reads the project again.
 */
const storageKey = (projectId: string) => `cutline:director:${projectId}`;

interface Stored {
  items: ThreadItem[];
  usage: DirectorUsage;
  phase: Phase | null;
}

function loadStored(projectId: string): Stored | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the loop */

export class Director {
  private state: DirectorState;
  private messages: ChatMessage[] = [];
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly projectId: string,
    private readonly host: () => DirectorHost | null,
  ) {
    const stored = loadStored(projectId);
    this.state = {
      items: (stored?.items ?? []).map((i) =>
        i.kind === "tool" && i.status === "running" ? { ...i, status: "error" as const, detail: "Interrupted: the editor was reloaded." } : i,
      ),
      running: false,
      phase: stored?.phase ?? null,
      doing: null,
      usage: stored?.usage ?? ZERO,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DirectorState => this.state;

  /** Sends a request. `shown` is what the thread shows for it, when the text sent is a long prompt. */
  async send(request: string, shown?: string): Promise<void> {
    const said = request.trim();
    if (!said || this.state.running) return;
    const host = this.host();
    if (!host) {
      this.note("This editor cannot take edits right now: the project is open in another editor that is saving it.", "error");
      return;
    }
    const recap = this.messages.length === 0 ? this.recap() : null;
    this.push({ kind: "user", text: shown ?? said, at: Date.now() });
    const blocks: ChatBlock[] = [...(recap ? [{ type: "text" as const, text: recap }] : []), { type: "text", text: said }];
    // After a stop mid-call the conversation already ends on the user's side.
    const last = this.messages.at(-1);
    if (last?.role === "user") last.content.push(...blocks);
    else this.messages.push({ role: "user", content: blocks });

    const abort = new AbortController();
    this.abort = abort;
    this.set({ running: true, doing: null });
    try {
      // One undo step per request, named after it — as start_turn does for an MCP agent.
      await host.execute("start_turn", { instruction: (shown ?? said).slice(0, 200) });
      for (let step = 0; !abort.signal.aborted; step += 1) {
        if (step === MAX_STEPS) {
          this.note(`Stopped after ${MAX_STEPS} steps. Say “continue” to go on.`);
          break;
        }
        this.trim();
        const providerId = host.chatProvider?.();
        const response = await chat(
          { system: SYSTEM, messages: this.request(), tools: tools(), projectId: this.projectId, ...(providerId ? { providerId } : {}) },
          abort.signal,
        );
        const u = this.state.usage;
        this.set({
          usage: {
            inputTokens: u.inputTokens + response.usage.inputTokens,
            outputTokens: u.outputTokens + response.usage.outputTokens,
            cachedTokens: u.cachedTokens + response.usage.cachedTokens,
            calls: u.calls + 1,
          },
        });
        if (response.content.length) this.messages.push({ role: "assistant", content: response.content });
        const reply = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n").trim();
        if (reply) this.push({ kind: "director", text: reply, at: Date.now() });
        const uses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (!uses.length) {
          if (response.stopReason === "max_tokens") this.note("The reply reached the model's length limit. Say “continue” to go on.");
          break;
        }
        const results: ToolResultBlock[] = [];
        for (const use of uses) results.push(abort.signal.aborted ? stopped(use) : await this.run(use, host));
        this.messages.push({ role: "user", content: results });
      }
    } catch (err) {
      if (!abort.signal.aborted) this.note(describeError(err), "error");
    } finally {
      host.onActivity(null);
      if (abort.signal.aborted) this.note("Stopped.");
      this.abort = null;
      this.set({ running: false, doing: null });
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  /** A new thread: the model forgets, the project keeps everything it did. */
  clear(): void {
    if (this.state.running) return;
    this.messages = [];
    this.set({ items: [], phase: null, doing: null, usage: ZERO });
  }

  private async run(use: ToolUseBlock, host: DirectorHost): Promise<ToolResultBlock> {
    this.push({ kind: "tool", id: use.id, name: use.name, summary: summarize(use.input), status: "running", at: Date.now() });
    host.onActivity(use.name);
    try {
      if (use.invalidJson !== undefined) throw new Error(`The arguments were not valid JSON: ${use.invalidJson.slice(0, 200)}`);
      const content = (await this.local(use.name, use.input)) ?? (await host.execute(use.name, use.input));
      const first = content.find((c) => c.type === "text");
      const image = content.find((c) => c.type === "image");
      this.updateTool(use.id, {
        status: "ok",
        ...(first?.type === "text" ? { detail: first.text.slice(0, 400) } : {}),
        ...(image?.type === "image" ? { image: `data:${image.mimeType};base64,${image.data}` } : {}),
      });
      return {
        type: "tool_result",
        toolUseId: use.id,
        content: content.map((c) =>
          c.type === "text" ? { type: "text" as const, text: clip(c.text) } : { type: "image" as const, mimeType: c.mimeType, data: c.data },
        ),
      };
    } catch (err) {
      const message = describeError(err);
      this.updateTool(use.id, { status: "error", detail: message });
      return { type: "tool_result", toolUseId: use.id, content: [{ type: "text", text: message }], isError: true };
    }
  }

  private async local(name: string, input: unknown): Promise<BridgeContent[] | null> {
    const spec = LOCAL_TOOLS[name];
    if (!spec) return null;
    const args = z.object(spec.input).parse(input ?? {}) as Record<string, unknown>;
    switch (name) {
      case "guide": {
        const topic = typeof args.topic === "string" ? GUIDE[args.topic] : undefined;
        return [text(topic ? `# ${topic.title}\n\n${topic.body}` : guideIndex())];
      }
      case "list_themes":
        return [
          text(
            JSON.stringify(
              THEMES.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                background: t.palette.backgroundTo ? [t.palette.background, t.palette.backgroundTo] : t.palette.background,
                text: t.palette.text,
                accent: t.palette.accent,
                fonts: { display: t.fonts.display.split(",")[0], body: t.fonts.body.split(",")[0] },
                motion: t.motion.enter,
              })).concat(
                (await listItems("looks").catch(() => [])).map((l) => ({ lookId: l.id, name: l.name, description: l.description }) as never),
              ),
            ),
          ),
        ];
      case "report_progress":
        this.set({ phase: args.phase as Phase, doing: String(args.doing) });
        return [text("Shown in the panel.")];
    }
    return null;
  }

  /** What was said before a reload, handed back to the model as context. */
  private recap(): string | null {
    const said = this.state.items.filter((i) => i.kind === "user" || i.kind === "director").slice(-16);
    if (!said.length) return null;
    const lines = said.map((i) => `${i.kind === "user" ? "User" : "You"}: ${(i as { text: string }).text.slice(0, 600)}`);
    return `Earlier in this project's Director thread, before the editor was reloaded (read the project again rather than trusting this):\n${lines.join("\n")}`;
  }

  /** The conversation as sent: only the latest frames, the rest a line of text. */
  private request(): ChatMessage[] {
    let images = 0;
    const earlier = { type: "text" as const, text: "[a frame shown earlier]" };
    return [...this.messages]
      .reverse()
      .map((m) => ({
        ...m,
        content: [...m.content]
          .reverse()
          .map((b): ChatBlock => {
            if (b.type === "image") return ++images > KEEP_IMAGES ? earlier : b;
            if (b.type === "tool_result" && b.content.some((c) => c.type === "image")) {
              return { ...b, content: [...b.content].reverse().map((c) => (c.type === "image" && ++images > KEEP_IMAGES ? earlier : c)).reverse() };
            }
            return b;
          })
          .reverse(),
      }))
      .reverse();
  }

  private trim(): void {
    if (this.messages.length <= MAX_MESSAGES) return;
    let from = this.messages.length - KEEP_MESSAGES;
    const plainUser = (m: ChatMessage) => m.role === "user" && m.content.every((b) => b.type !== "tool_result");
    while (from < this.messages.length && !plainUser(this.messages[from]!)) from += 1;
    if (from < this.messages.length) this.messages = this.messages.slice(from);
  }

  private note(message: string, tone: "info" | "error" = "info"): void {
    this.push({ kind: "note", text: message, tone, at: Date.now() });
  }

  private push(item: ThreadItem): void {
    this.set({ items: [...this.state.items, item].slice(-400) });
  }

  private updateTool(id: string, patch: Partial<Extract<ThreadItem, { kind: "tool" }>>): void {
    const items = [...this.state.items];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.kind === "tool" && item.id === id) {
        items[i] = { ...item, ...patch };
        break;
      }
    }
    this.set({ items });
  }

  private set(patch: Partial<DirectorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }

  private save(): void {
    try {
      const items = this.state.items.slice(-200).map((i) => (i.kind === "tool" ? { ...i, image: undefined, detail: i.detail?.slice(0, 300) } : i));
      const stored: Stored = { items, usage: this.state.usage, phase: this.state.phase };
      localStorage.setItem(storageKey(this.projectId), JSON.stringify(stored));
    } catch {
      // Storage full or blocked: the thread lives on in memory.
    }
  }
}
