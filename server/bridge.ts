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

  message(ws: WSContext, data: string): void {
    const key = ws.raw as object;
    let message: FromTab;
    try {
      message = JSON.parse(data) as FromTab;
    } catch {
      return;
    }
    if (message.type === "hello") {
      this.tabs.set(key, { ws, projectId: message.projectId, name: message.name, seenAt: Date.now() });
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
    this.tabs.delete(key);
    for (const [id, waiting] of this.pending) {
      if (waiting.tab !== key) continue;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The editor closed before it answered."));
    }
  }

  /** The editor the user touched last. */
  active(): Tab | undefined {
    let best: Tab | undefined;
    for (const tab of this.tabs.values()) if (!best || tab.seenAt > best.seenAt) best = tab;
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
