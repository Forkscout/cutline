/**
 * What agents may do, and what it all cost.
 *
 *   bun scripts/agents-check.ts
 *
 * Reads the agent settings, turns a permission off and checks that the MCP
 * relay refuses the call, then puts the permission back. It does not rotate
 * the token: that would stop every agent already registered on this machine,
 * which is a thing to do on purpose, not in a check. Needs `bun run dev`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const WEB = process.env.CUTLINE_WEB_URL ?? "http://localhost:5310";
const API = process.env.CUTLINE_API_URL ?? "http://127.0.0.1:5311";
const token = /name="cutline-token" content="([a-f0-9]+)"/.exec(await (await fetch(WEB)).text())?.[1];
if (!token) throw new Error("No token in the page — is `bun run dev` running?");

const api = <T>(route: string, init: RequestInit = {}): Promise<T> =>
  fetch(`${API}/api${route}`, { ...init, headers: { ...(init.headers ?? {}), "x-cutline-token": token } }).then((r) => r.json() as Promise<T>);
const post = (route: string, body: unknown) => api(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

interface Agents {
  registration: string;
  tokenFile: string;
  tokenTail: string;
  permissions: { mayExport: boolean; mayImport: boolean; mayDeleteOthersClips: boolean };
  clients: { name: string; calls: number }[];
  editors: { name: string; holder: boolean }[];
}

const before = await api<Agents>("/agents");
check("the registration line names this server and the token file", before.registration.includes("/mcp") && before.registration.includes(before.tokenFile));
check("the token itself never comes back, only its tail", !before.registration.includes(readFileSync(path.join(homedir(), "Cutline", "mcp-token"), "utf8").trim()) && before.tokenTail.length === 4);
check("permissions come with defaults", typeof before.permissions.mayExport === "boolean" && typeof before.permissions.mayDeleteOthersClips === "boolean");

const mcp = new Client({ name: "agents-check", version: "1" });
await mcp.connect(
  new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${readFileSync(path.join(homedir(), "Cutline", "mcp-token"), "utf8").trim()}` } },
  }),
);
try {
  await post("/agents/permissions", { mayExport: false });
  const refused = (await mcp.callTool({ name: "export_video", arguments: { name: "agents-check" } }, undefined, { timeout: 30_000 })) as {
    isError?: boolean;
    content: { text?: string }[];
  };
  check("an export is refused while it is turned off", Boolean(refused.isError) && (refused.content[0]?.text ?? "").includes("turned off"), refused.content[0]?.text?.slice(0, 80) ?? "");
  const seen = await api<Agents>("/agents");
  check("the client that called is remembered", seen.clients.some((c) => c.name === "agents-check" && c.calls > 0), seen.clients.map((c) => `${c.name}:${c.calls}`).join(", "));
} finally {
  await post("/agents/permissions", { mayExport: before.permissions.mayExport });
  await mcp.close();
}
const after = await api<Agents>("/agents");
check("the permission is put back", after.permissions.mayExport === before.permissions.mayExport);

const usage = await api<{ totals: { calls: number; inputTokens: number; transcribedSeconds: number }; byDay: unknown[]; entriesRead: number }>("/agents/usage?days=30");
check("usage reads back as a summary", typeof usage.totals.calls === "number" && Array.isArray(usage.byDay), `${usage.entriesRead} entries, ${usage.totals.calls} calls, ${Math.round(usage.totals.transcribedSeconds)} s transcribed`);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
