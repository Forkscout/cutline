/**
 * Two editors, one project: checks that the server decides which one saves,
 * and that an agent's calls reach only that one. Then one page, several
 * sockets: that a call outlives the socket it went out on, and that every call
 * names the project's turn. Speaks the bridge protocol directly, standing in
 * for browsers the page's own lock cannot see.
 *
 *   bun scripts/lock-check.ts      (needs `bun run dev`; takes about 15 s)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FromTab, ToTab } from "../src/editor/agent-tools";

const html = await (await fetch("http://localhost:5310")).text();
const token = /name="cutline-token" content="([a-f0-9]+)"/.exec(html)?.[1];
if (!token) throw new Error("No token in the page — is `bun run dev` running?");
const mcpToken = readFileSync(path.join(homedir(), "Cutline", "mcp-token"), "utf8").trim();

type Call = Extract<ToTab, { type: "call" }>;

class FakeEditor {
  lock: { holder: boolean; editors: number } | null = null;
  /** Calls held for the test to answer, when the editor is silent. */
  calls: Call[] = [];
  closed = false;
  private waiters: (() => void)[] = [];
  private constructor(readonly name: string, readonly ws: WebSocket) {}

  /**
   * `pageId` is fresh unless given: a second socket with the same one is the
   * same page reconnecting. A silent editor holds its calls instead of
   * answering each with its name.
   */
  static open(
    name: string,
    projectId: string,
    options: { wasHolder?: boolean; pageId?: string; silent?: boolean; touchedAt?: number } = {},
  ): Promise<FakeEditor> {
    const ws = new WebSocket("ws://127.0.0.1:5311/api/bridge", { headers: { "x-cutline-token": token! } } as never);
    const editor = new FakeEditor(name, ws);
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ToTab;
      if (message.type === "lock") editor.lock = { holder: message.holder, editors: message.editors };
      else if (options.silent) editor.calls.push(message);
      // Answer every call with this editor's name, so the test can see who got it.
      else editor.answer(message, name);
      editor.wake();
    };
    ws.onclose = () => {
      editor.closed = true;
      editor.wake();
    };
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        const pageId = options.pageId ?? crypto.randomUUID();
        ws.send(
          JSON.stringify({
            type: "hello",
            pageId,
            projectId,
            name,
            wasHolder: options.wasHolder ?? false,
            ...(options.touchedAt !== undefined ? { touchedAt: options.touchedAt } : {}),
          } satisfies FromTab),
        );
        resolve(editor);
      };
      ws.onerror = () => reject(new Error(`${name} could not connect`));
    });
  }

  private wake() {
    this.waiters.splice(0).forEach((w) => w());
  }

  /** Resolves once `test` holds, checking on every message; false after `ms`. */
  async wait(test: () => boolean, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!test()) {
      if (Date.now() > deadline) return false;
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
    return true;
  }

  /** Resolves once the server has said something that satisfies `test`. */
  until(test: (lock: { holder: boolean; editors: number }) => boolean): Promise<boolean> {
    return this.wait(() => this.lock !== null && test(this.lock));
  }

  async nextCall(): Promise<Call> {
    if (!(await this.wait(() => this.calls.length > 0))) throw new Error(`${this.name} was sent no call`);
    return this.calls.shift()!;
  }

  answer(call: Call, text: string) {
    this.send({ type: "result", id: call.id, ok: true, content: [{ type: "text", text }] });
  }

  send(message: FromTab) {
    this.ws.send(JSON.stringify(message));
  }

  close() {
    this.ws.close();
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const client = new Client({ name: "lock-check", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:5311/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
  }),
);
const callText = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[] };
  return result.content[0]?.text ?? "";
};
const whoAnswers = () => callText("get_editor_state");

const project = `lock-check-${crypto.randomUUID()}`;
const a = await FakeEditor.open("A", project);
check("the first editor holds the project", await a.until((l) => l.holder && l.editors === 1));

const b = await FakeEditor.open("B", project);
check("a second editor, in another browser, does not", await b.until((l) => !l.holder && l.editors === 2));
check("the first keeps it, and learns it is not alone", await a.until((l) => l.holder && l.editors === 2));
check("an agent's call goes to the one that saves", (await whoAnswers()) === "A");

b.send({ type: "takeover" });
check("take-over moves the hold", (await b.until((l) => l.holder)) && (await a.until((l) => !l.holder)));
check("and the agent follows it", (await whoAnswers()) === "B");

b.close();
check("when the holder closes, the other editor is promoted", await a.until((l) => l.holder && l.editors === 1));
check("and the agent follows again", (await whoAnswers()) === "A");

// After a restart every editor reconnects, in no particular order.
const other = `lock-check-${crypto.randomUUID()}`;
const c = await FakeEditor.open("C", other, { wasHolder: false });
await c.until((l) => l.holder);
const d = await FakeEditor.open("D", other, { wasHolder: true });
check("the editor that held a project before a restart gets it back",
  (await d.until((l) => l.holder)) && (await c.until((l) => !l.holder)));
const e = await FakeEditor.open("E", other, { wasHolder: false });
check("a newly opened editor does not take it", await e.until((l) => !l.holder && l.editors === 3));

for (const editor of [a, c, d, e]) editor.close();

// The agent's calls go to the editor the user touched last. After a restart
// the editors reconnect in any order, and the last one back is not that one.
const recent = await FakeEditor.open("recent", `lock-check-${crypto.randomUUID()}`, { touchedAt: Date.now() });
const stale = await FakeEditor.open("stale", `lock-check-${crypto.randomUUID()}`, { touchedAt: Date.now() - 60_000 });
await recent.until((l) => l.holder);
await stale.until((l) => l.holder);
check("reconnecting last does not take the agent from the editor touched last", (await whoAnswers()) === "recent");
recent.close();
stale.close();

// One page, several sockets. The page keeps working on a call while its
// socket is replaced, and answers on whichever one it has by then.
const third = `lock-check-${crypto.randomUUID()}`;
const pageId = crypto.randomUUID();
const f1 = await FakeEditor.open("F1", third, { pageId, silent: true });
await f1.until((l) => l.holder);

const first = whoAnswers();
const firstCall = await f1.nextCall();
f1.close();
await f1.wait(() => f1.closed);
const f2 = await FakeEditor.open("F2", third, { pageId, wasHolder: true, silent: true });
f2.answer(firstCall, "answered on the next socket");
check("a call outlives its page reconnecting", (await first) === "answered on the next socket");

const second = whoAnswers();
const secondCall = await f2.nextCall();
const f3 = await FakeEditor.open("F3", third, { pageId, wasHolder: true, silent: true });
check("a second socket from the same page replaces the first", await f2.wait(() => f2.closed));
f3.answer(secondCall, "answered after the replacement");
check("and the call on the replaced socket survives it", (await second) === "answered after the replacement");

const turnStarted = callText("start_turn", { instruction: "lock check: one request" });
f3.answer(await f3.nextCall(), "ok");
await turnStarted;
const afterTurn = whoAnswers();
const turnCall = await f3.nextCall();
f3.answer(turnCall, "ok");
await afterTurn;
check("every call names the project's turn", turnCall.turn === "lock check: one request", String(turnCall.turn));

const stranded = whoAnswers();
await f3.nextCall();
f3.close();
const leftAt = Date.now();
const reason = await stranded;
const waited = (Date.now() - leftAt) / 1000;
check("a page that does not come back fails its calls, after a grace",
  reason === "The editor closed before it answered." && waited >= 9, `${reason} after ${waited.toFixed(1)} s`);

await client.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
