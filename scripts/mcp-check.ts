/**
 * End-to-end check of the MCP endpoint, as a real MCP client.
 *
 *   bun scripts/mcp-check.ts setup          creates a test project, prints its URL
 *   bun scripts/mcp-check.ts run <id>       checks it while it is open in the editor
 *   bun scripts/mcp-check.ts cleanup <id>   deletes it
 *
 * `run` needs `bun run dev` running and the project open in a browser tab —
 * the tools edit the project in the editor, never on disk.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ACTION_TOOLS, EDITOR_TOOLS } from "../src/editor/agent-tools";
import { createProject } from "../src/editor/project";

const WEB = "http://localhost:5310";
const MCP = "http://127.0.0.1:5311/mcp";
const HOME = process.env.CUTLINE_HOME ?? path.join(homedir(), "Cutline");
const MCP_TOKEN = readFileSync(path.join(HOME, "mcp-token"), "utf8").trim();

async function pageToken(): Promise<string> {
  const html = await (await fetch(WEB)).text();
  const match = /name="cutline-token" content="([a-f0-9]+)"/.exec(html);
  if (!match?.[1]) throw new Error("No token in the page — is `bun run dev` running?");
  return match[1];
}

async function rest(method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`${WEB}${route}`, {
    method,
    headers: { "x-cutline-token": await pageToken(), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/* ------------------------------------------------------------------ png */

/** Enough PNG to read a canvas export: 8-bit RGB or RGBA, not interlaced. */
function decodePng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Uint8Array[] = [];
  while (pos < bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      channels = bytes[pos + 17] === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(bytes.subarray(pos + 8, pos + 8 + length));
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const v = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0;
      out[y * stride + x] = (v + add) & 255;
    }
  }
  return {
    width,
    height,
    pixel: (x: number, y: number) => {
      const i = Math.round(y) * stride + Math.round(x) * channels;
      return [out[i]!, out[i + 1]!, out[i + 2]!] as const;
    },
  };
}

/* ---------------------------------------------------------------- checks */

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

type Result = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

async function run(projectId: string) {
  const client = new Client({ name: "cutline-mcp-check", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> =>
    (await client.callTool({ name, arguments: args })) as Result;
  const textOf = (r: Result) => r.content.find((c) => c.type === "text")?.text ?? "";
  const jsonOf = <T>(r: Result) => JSON.parse(textOf(r)) as T;

  console.log("\nthe endpoint");
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
  const bare = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(initialize) });
  check("no bearer token is refused", bare.status === 401, String(bare.status));
  const browser = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, origin: "https://evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(initialize),
  });
  check("a web page's origin is refused", browser.status === 403, String(browser.status));

  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const expected = [...Object.values(ACTION_TOOLS), ...Object.values(EDITOR_TOOLS)].map((t) => t.name);
  const missing = expected.filter((n) => !names.has(n));
  check("every reducer action has a tool", missing.length === 0, missing.join(", ") || `${Object.keys(ACTION_TOOLS).length} actions`);
  check("tools are listed with schemas", tools.every((t) => t.inputSchema?.type === "object"), `${tools.length} tools`);
  const destructive = tools.filter((t) => /recording|project/.test(t.name) && /delete|remove/.test(t.name));
  check("no tool deletes recordings or projects", destructive.length === 0, destructive.map((t) => t.name).join(", "));

  let rejected = false;
  try {
    const bad = await call("split_clip", { trackId: "x", clipId: "y", time: "abc" });
    rejected = Boolean(bad.isError) && /valid/i.test(textOf(bad));
  } catch (err) {
    rejected = /valid/i.test(String(err));
  }
  check("a malformed call is rejected before the reducer", rejected);

  console.log("\nthe open editor");
  const state = jsonOf<{ projectId: string; tracks: { id: string; kind: string }[] }>(await call("get_editor_state"));
  check("the check project is the one open", state.projectId === projectId, state.projectId);
  const v1 = state.tracks.find((t) => t.kind === "video")!.id;
  const a1 = state.tracks.find((t) => t.kind === "audio")!.id;

  const before = textOf(await call("get_project", { full: true }));

  console.log("\na turn");
  await call("start_turn", { instruction: "mcp check: red box" });
  const added = jsonOf<{ added: { clipId: string }[]; undoStep: string }>(
    await call("add_clip", { trackId: v1, kind: "shape", start: 0, duration: 4, shape: { kind: "rectangle", fill: "#ff0000" } }),
  );
  const box = added.added[0]?.clipId ?? "";
  check("add_clip returns the new clip's id", Boolean(box), added.undoStep);
  await call("set_transform", { trackId: v1, clipId: box, patch: { x: 0.25, y: 0.5, scale: 0.3 } });
  await call("add_marker", { time: 1, name: "check" });

  const frame = await call("render_frame", { time: 1, width: 640, format: "png" });
  const image = frame.content.find((c) => c.type === "image");
  check("render_frame returns an image", Boolean(image?.data), textOf(frame));
  if (image?.data) {
    const png = decodePng(Buffer.from(image.data, "base64"));
    const [r, g, b] = png.pixel(png.width * 0.25, png.height * 0.5);
    check("the box is red where it was placed", r > 200 && g < 60 && b < 60, `rgb(${r},${g},${b})`);
    const [br, bg, bb] = png.pixel(png.width * 0.9, png.height * 0.1);
    check("the background is blue away from it", bb > 200 && br < 60 && bg < 60, `rgb(${br},${bg},${bb})`);
  }

  const sheet = await call("contact_sheet", { start: 0, end: 4, count: 4 });
  check("contact_sheet returns one image of the range", sheet.content.some((c) => c.type === "image"), textOf(sheet));

  const silent = jsonOf<{ silences: { start: number; end: number }[] }>(await call("audio_envelope", { start: 0, end: 4 }));
  check("a range with no sound is reported silent", silent.silences.length === 1 && silent.silences[0]!.end >= 3.9, JSON.stringify(silent.silences));

  await call("undo");
  const after = textOf(await call("get_project", { full: true }));
  check("one undo takes back the whole turn, exactly", after === before);

  console.log("\nhearing");
  const recordings = jsonOf<{ id: string; tracks: string[] }[]>(await call("list_recordings"));
  const withMic = recordings.find((r) => r.tracks.includes("microphone"));
  if (withMic) {
    await call("start_turn", { instruction: "mcp check: plant a gap" });
    const imported = await call("import_recording", { sessionId: withMic.id });
    check("import_recording adds the take", !imported.isError, textOf(imported).slice(0, 80));
    const project = JSON.parse(textOf(await call("get_project"))) as { assets: { id: string; sourceKind?: string; durationSec: number }[] };
    const mic = project.assets.find((a) => a.sourceKind === "microphone")!;
    await call("add_clip", { trackId: a1, kind: "media", assetId: mic.id, start: 2 });
    const env = jsonOf<{ silences: { start: number; end: number }[]; unmeasured: string[] }>(
      await call("audio_envelope", { start: 0, end: 2 + mic.durationSec }),
    );
    const gap = env.silences[0];
    check("a planted two-second gap is found", Boolean(gap) && gap!.start === 0 && Math.abs(gap!.end - 2) < 0.25, JSON.stringify(env.silences));
    await call("undo");
  } else {
    console.log("SKIP  no recording with a microphone to plant a gap in");
  }

  console.log("\nthe tab is the source of truth");
  await call("set_project", { patch: { name: "MCP check (saved)" } });
  const live = textOf(await call("get_project", { full: true }));
  let onDisk = "";
  for (let i = 0; i < 20 && onDisk !== live; i += 1) {
    await Bun.sleep(500);
    const res = await rest("GET", `/api/projects/${projectId}`);
    onDisk = JSON.stringify(((await res.json()) as { project: unknown }).project);
  }
  check("what the agent reads is what autosave writes, byte for byte", onDisk === live);

  await client.close();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

const [command, id] = process.argv.slice(2);
if (command === "setup") {
  const project = createProject("MCP check");
  project.width = 1280;
  project.height = 720;
  project.background = { type: "solid", color: "#0000ff" };
  const res = await rest("PUT", `/api/projects/${project.id}`, { version: 1, project });
  if (!res.ok) throw new Error(`Could not create the project (${res.status}).`);
  console.log(`${project.id}\n${WEB}/?project=${project.id}`);
} else if (command === "run" && id) {
  await run(id);
} else if (command === "cleanup" && id) {
  console.log((await rest("DELETE", `/api/projects/${id}`)).status);
} else {
  console.log("usage: bun scripts/mcp-check.ts setup | run <id> | cleanup <id>");
}
