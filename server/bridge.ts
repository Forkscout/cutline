/**
 * The server's end of the agent bridge: editor tabs connect over a WebSocket,
 * and MCP tool calls are relayed to one of them.
 *
 * The server never edits a project itself. The tab holds the live document —
 * possibly ahead of what is on disk — so a write here would be overwritten by
 * its next autosave. Relaying keeps one source of truth and lets the user watch.
 */

import type { WSContext } from "hono/ws";
import type { BridgeContent, FromTab, ToTab } from "../src/editor/agent-tools";

interface Tab {
  ws: WSContext;
  pageId: string;
  connectedAt: number;
  projectId: string;
  name: string;
  /** When the user last opened or focused this tab. The latest one is "the editor". */
  seenAt: number;
}

interface Pending {
  /**
   * The page the call went to, not the socket. A page drops its socket and
   * opens another for many reasons — a rebuilt bridge, a hot reload, a proxy
   * that lost the old one — while the call runs on in it, and the answer
   * arrives on whichever socket the page has by then.
   */
  pageId: string;
  resolve: (content: BridgeContent[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A page that lost its socket and may be on its way back. */
interface Away {
  /** Fails the page's calls when the grace is over. */
  timer: ReturnType<typeof setTimeout>;
  /** Whether new calls should wait for it: it held its project, and its socket dropped rather than being closed. */
  expected: boolean;
  seenAt: number;
}

/**
 * Close codes a page sends when it closes its socket itself: the editor
 * closed, the page unloaded, or a bridge is being rebuilt, which reconnects at
 * once. A connection that dropped has no say in its code (1006).
 */
const CLOSED_ON_PURPOSE = new Set([1000, 1001, 1005]);

export class NoEditorOpen extends Error {
  constructor() {
    super(
      "No project is open in Cutline. Ask the user to open one at http://localhost:5310 — these tools edit the project open in the editor.",
    );
  }
}

/** Rendering a contact sheet of a long 4K take is the slowest call there is. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * How long a page that lost its socket has to come back before its calls
 * fail, and how long new calls wait for it meanwhile. The tab retries every
 * second at first, so this is several attempts.
 */
const RECONNECT_GRACE_MS = 10_000;

/**
 * After a start, how long the editors have to reconnect before a call picks
 * one. They come back in no particular order — a hidden tab's timers run late
 * — and the first call after a restart once went to the first editor back,
 * which had another project open, instead of the one the user was using.
 */
const SETTLE_MS = 3000;

export class TabBridge {
  // Keyed by the runtime socket: hono may hand each event a fresh WSContext.
  private tabs = new Map<object, Tab>();
  private pending = new Map<string, Pending>();
  /**
   * The editor that may write each project. The page's own lock is a
   * BroadcastChannel and only reaches tabs of one browser; this is the lock
   * for everything else. `claimed` is false when the hold was handed out by
   * default, so the editor that held it before a restart can take it back.
   */
  private holders = new Map<string, { key: object; claimed: boolean }>();
  /** By page id. */
  private away = new Map<string, Away>();
  /**
   * The instruction of each project's current turn, sent with every call. The
   * tab keeps its own copy, which outlives a server restart; this one outlives
   * a reload of the page, and follows the hold from one editor to another.
   */
  private turns = new Map<string, string>();
  private startedAt = Date.now();
  /** Calls waiting for the editors to settle. */
  private waiting = new Set<() => void>();

  /** The editors connected now: which project each has open, and which one saves it. */
  editors(): { projectId: string; name: string; holder: boolean; connectedAt: number; seenAt: number }[] {
    return [...this.tabs.entries()]
      .map(([key, tab]) => ({
        projectId: tab.projectId,
        name: tab.name,
        holder: this.holders.get(tab.projectId)?.key === key,
        connectedAt: tab.connectedAt,
        seenAt: tab.seenAt,
      }))
      .sort((a, b) => b.seenAt - a.seenAt);
  }

  message(ws: WSContext, data: string): void {
    const key = ws.raw as object;
    let message: FromTab;
    try {
      message = JSON.parse(data) as FromTab;
    } catch {
      return;
    }
    if (message.type === "hello") {
      // A page holds one socket. If it already had another, that one is stale —
      // a reconnect whose predecessor never closed — and answering calls on it
      // would split the agent's work across two editors' worth of state. Its
      // calls stay pending: they belong to the page, which answers them here.
      for (const [otherKey, other] of this.tabs) {
        if (otherKey !== key && other.pageId === message.pageId) {
          this.tabs.delete(otherKey);
          other.ws.close(4000, "Replaced by a newer connection from the same page");
        }
      }
      clearTimeout(this.away.get(message.pageId)?.timer);
      this.away.delete(message.pageId);
      const now = Date.now();
      this.tabs.set(key, {
        ws,
        pageId: message.pageId,
        connectedAt: now,
        projectId: message.projectId,
        name: message.name,
        // A reconnect is not the user choosing this editor; when they last did is the page's to say.
        seenAt: Math.min(now, message.touchedAt ?? now),
      });
      console.log(
        `bridge          editor connected: ${message.name} [page ${String(message.pageId).slice(0, 8)}, ${message.where ?? "?"}] (${this.tabs.size} open)`,
      );
      this.claim(key, message.projectId, message.wasHolder === true);
      this.wake();
    } else if (message.type === "takeover") {
      const tab = this.tabs.get(key);
      if (tab) {
        this.holders.set(tab.projectId, { key, claimed: true });
        this.announce(tab.projectId);
      }
    } else if (message.type === "focus") {
      const tab = this.tabs.get(key);
      if (tab) tab.seenAt = Date.now();
    } else if (message.type === "result") {
      const waiting = this.pending.get(message.id);
      if (!waiting || this.tabs.get(key)?.pageId !== waiting.pageId) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.content);
      else waiting.reject(new Error(message.error));
    }
  }

  close(ws: WSContext, code?: number): void {
    const key = ws.raw as object;
    const tab = this.tabs.get(key);
    // A socket that hello already replaced is gone from the map, and its page is still here.
    if (!tab) return;
    const expected = this.holders.get(tab.projectId)?.key === key && !CLOSED_ON_PURPOSE.has(code ?? 1006);
    this.tabs.delete(key);
    console.log(`bridge          editor disconnected: ${tab.name} [page ${String(tab.pageId).slice(0, 8)}] (${this.tabs.size} open)`);
    this.release(key, tab.projectId);
    if (![...this.tabs.values()].some((t) => t.pageId === tab.pageId)) this.awaitReturn(tab.pageId, expected, tab.seenAt);
  }

  /**
   * Gives a page that lost its socket a moment to reconnect before failing the
   * calls it was running. It is usually the same page coming straight back,
   * with the work still going on in it; an agent told "the editor closed" would
   * start the work again, or give up on a transcription that was about to land.
   */
  private awaitReturn(pageId: string, expected: boolean, seenAt: number): void {
    clearTimeout(this.away.get(pageId)?.timer);
    const timer = setTimeout(() => {
      this.away.delete(pageId);
      for (const [id, waiting] of this.pending) {
        if (waiting.pageId !== pageId) continue;
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        waiting.reject(new Error("The editor closed before it answered."));
      }
      // A call that was waiting for this page chooses among the others now.
      this.wake();
    }, RECONNECT_GRACE_MS);
    this.away.set(pageId, { timer, expected, seenAt });
  }

  /** Decides whether a newly connected editor holds its project. */
  private claim(key: object, projectId: string, wasHolder: boolean): void {
    const current = this.holders.get(projectId);
    if (!current || !this.tabs.has(current.key)) {
      this.holders.set(projectId, { key, claimed: wasHolder });
    } else if (wasHolder && !current.claimed) {
      // After a restart every editor reconnects in no particular order. The
      // one that held the project before takes it back from whichever editor
      // happened to reconnect first.
      this.holders.set(projectId, { key, claimed: true });
    }
    this.announce(projectId);
  }

  /** When the holder goes, the longest-open remaining editor takes over. */
  private release(key: object, projectId: string): void {
    if (this.holders.get(projectId)?.key === key) {
      const next = [...this.tabs.entries()]
        .filter(([, tab]) => tab.projectId === projectId)
        .sort((a, b) => a[1].connectedAt - b[1].connectedAt)[0];
      if (next) this.holders.set(projectId, { key: next[0], claimed: false });
      else this.holders.delete(projectId);
    }
    this.announce(projectId);
  }

  private announce(projectId: string): void {
    const holder = this.holders.get(projectId)?.key;
    const editors = [...this.tabs.entries()].filter(([, tab]) => tab.projectId === projectId);
    for (const [key, tab] of editors) {
      tab.ws.send(JSON.stringify({ type: "lock", holder: key === holder, editors: editors.length } satisfies ToTab));
    }
  }

  /**
   * The editor the user touched last, among those that hold their project.
   * An editor that is not saving must never take an agent's edits: they would
   * look applied and then vanish, never having reached disk.
   */
  active(): Tab | undefined {
    let best: Tab | undefined;
    for (const [key, tab] of this.tabs) {
      if (this.holders.get(tab.projectId)?.key !== key) continue;
      if (!best || tab.seenAt > best.seenAt) best = tab;
    }
    return best;
  }

  /**
   * The editor to relay to — but not while the one the user touched last may
   * be on its way back. Right after a start every editor is reconnecting; after
   * a dropped connection, that page may be about to return. Choosing from
   * whoever happens to be connected then puts the agent's edit in another
   * project, so the call waits: for the start to settle, for that page to come
   * back or its grace to run out, or, with no editor at all, for one to connect.
   */
  private async editor(): Promise<Tab | undefined> {
    for (;;) {
      const tab = this.active();
      const now = Date.now();
      const settled = this.startedAt + SETTLE_MS;
      const returning = [...this.away.values()].some((a) => a.expected && a.seenAt > (tab?.seenAt ?? 0));
      const wait =
        now < settled ? settled - now
        : returning ? RECONNECT_GRACE_MS
        : tab ? 0
        : this.startedAt + RECONNECT_GRACE_MS - now;
      if (wait <= 0) return tab;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(done, wait);
        this.waiting.add(done);
      });
    }
  }

  /** Lets waiting calls look again: an editor connected, or a page's grace ran out. */
  private wake(): void {
    for (const done of [...this.waiting]) done();
  }

  async call(tool: string, args: unknown): Promise<BridgeContent[]> {
    const tab = await this.editor();
    if (!tab) throw new NoEditorOpen();
    const instruction = (args as { instruction?: unknown } | null)?.instruction;
    if (tool === "start_turn" && typeof instruction === "string") this.turns.set(tab.projectId, instruction);
    const turn = this.turns.get(tab.projectId);
    const id = crypto.randomUUID();
    return new Promise<BridgeContent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The editor did not answer ${tool} within ${CALL_TIMEOUT_MS / 1000} s.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { pageId: tab.pageId, resolve, reject, timer });
      tab.ws.send(JSON.stringify({ type: "call", id, tool, args, ...(turn !== undefined ? { turn } : {}) } satisfies ToTab));
    });
  }
}
