/**
 * Two editors, one project: checks that the server decides which one saves,
 * and that an agent's calls reach only that one. Speaks the bridge protocol
 * directly, standing in for two browsers the page's own lock cannot see.
 *
 *   bun scripts/lock-check.ts      (needs `bun run dev`)
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

class FakeEditor {
  lock: { holder: boolean; editors: number } | null = null;
  private waiters: (() => void)[] = [];
  private constructor(readonly name: string, readonly ws: WebSocket) {}

  static open(name: string, projectId: string, wasHolder = false): Promise<FakeEditor> {
    const ws = new WebSocket("ws://127.0.0.1:5311/api/bridge", { headers: { "x-cutline-token": token! } } as never);
    const editor = new FakeEditor(name, ws);
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ToTab;
      if (message.type === "lock") {
        editor.lock = { holder: message.holder, editors: message.editors };
        editor.waiters.splice(0).forEach((w) => w());
      } else if (message.type === "call") {
        // Answer every call with this editor's name, so the test can see who got it.
        ws.send(JSON.stringify({ type: "result", id: message.id, ok: true, content: [{ type: "text", text: name }] } satisfies FromTab));
      }
    };
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", pageId: crypto.randomUUID(), projectId, name, wasHolder } satisfies FromTab));
        resolve(editor);
      };
      ws.onerror = () => reject(new Error(`${name} could not connect`));
    });
  }

  /** Resolves once the server has said something that satisfies `test`. */
  async until(test: (lock: { holder: boolean; editors: number }) => boolean): Promise<boolean> {
    const deadline = Date.now() + 3000;
    while (!(this.lock && test(this.lock))) {
      if (Date.now() > deadline) return false;
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
    return true;
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
const whoAnswers = async () => {
  const result = (await client.callTool({ name: "get_editor_state", arguments: {} })) as { content: { text?: string }[] };
  return result.content[0]?.text ?? "";
};

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
const c = await FakeEditor.open("C", other, false);
await c.until((l) => l.holder);
const d = await FakeEditor.open("D", other, true);
check("the editor that held a project before a restart gets it back",
  (await d.until((l) => l.holder)) && (await c.until((l) => !l.holder)));
const e = await FakeEditor.open("E", other, false);
check("a newly opened editor does not take it", await e.until((l) => !l.holder && l.editors === 3));

for (const editor of [a, c, d, e]) editor.close();
await client.close();
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
