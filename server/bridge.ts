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
  /** When the user last connected or focused this tab. The latest one is "the editor". */
  seenAt: number;
}

interface Pending {
  tab: object;
  resolve: (content: BridgeContent[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NoEditorOpen extends Error {
  constructor() {
    super(
      "No project is open in Cutline. Ask the user to open one at http://localhost:5310 — these tools edit the project open in the editor.",
    );
  }
}

/** Rendering a contact sheet of a long 4K take is the slowest call there is. */
const CALL_TIMEOUT_MS = 120_000;

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
      // would split the agent's work across two editors' worth of state.
      for (const [otherKey, other] of this.tabs) {
        if (otherKey !== key && other.pageId === message.pageId) {
          this.tabs.delete(otherKey);
          other.ws.close(4000, "Replaced by a newer connection from the same page");
        }
      }
      this.tabs.set(key, {
        ws,
        pageId: message.pageId,
        connectedAt: Date.now(),
        projectId: message.projectId,
        name: message.name,
        seenAt: Date.now(),
      });
      console.log(
        `bridge          editor connected: ${message.name} [page ${String(message.pageId).slice(0, 8)}, ${message.where ?? "?"}] (${this.tabs.size} open)`,
      );
      this.claim(key, message.projectId, message.wasHolder === true);
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
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.content);
      else waiting.reject(new Error(message.error));
    }
  }

  close(ws: WSContext): void {
    const key = ws.raw as object;
    const tab = this.tabs.get(key);
    this.tabs.delete(key);
    if (tab) {
      console.log(`bridge          editor disconnected: ${tab.name} [page ${String(tab.pageId).slice(0, 8)}] (${this.tabs.size} open)`);
      this.release(key, tab.projectId);
    }
    for (const [id, waiting] of this.pending) {
      if (waiting.tab !== key) continue;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The editor closed before it answered."));
    }
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

  call(tool: string, args: unknown): Promise<BridgeContent[]> {
    const tab = this.active();
    if (!tab) return Promise.reject(new NoEditorOpen());
    const key = tab.ws.raw as object;
    const id = crypto.randomUUID();
    return new Promise<BridgeContent[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The editor did not answer ${tool} within ${CALL_TIMEOUT_MS / 1000} s.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { tab: key, resolve, reject, timer });
      tab.ws.send(JSON.stringify({ type: "call", id, tool, args } satisfies ToTab));
    });
  }
}
