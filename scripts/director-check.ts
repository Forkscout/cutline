/**
 * The Director's model calls, against stand-in services: no key, no cost.
 *
 *   bun scripts/director-check.ts        the translation, both ways, for
 *                                        Anthropic's API and OpenAI's
 *   bun scripts/director-check.ts serve  keeps a scripted OpenAI-compatible
 *                                        model connected, to drive the Director
 *                                        panel by hand; Ctrl+C disconnects it
 *
 * Each stand-in records what it was sent, so the checks read the request the
 * server actually made — the tool calls, the tool results, the frames, the
 * cache breakpoints, the headers — not what it meant to make. Leaves the
 * user's own providers and their order alone, and takes its entries back out
 * of ~/Cutline/usage.jsonl. Needs `bun run dev`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ChatRequest, ChatResponse } from "../src/lib/chat-protocol";

const WEB = process.env.CUTLINE_WEB_URL ?? "http://localhost:5310";
const API = process.env.CUTLINE_API_URL ?? "http://127.0.0.1:5311";
const html = await (await fetch(WEB)).text();
const token = /name="cutline-token" content="([a-f0-9]+)"/.exec(html)?.[1];
if (!token) throw new Error("No token in the page — is `bun run dev` running?");

async function api<T>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  headers.set("x-cutline-token", token!);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${API}/api${route}`, { ...init, headers });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

type Seen = { headers: Record<string, string>; body: any }[];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const lastText = (body: any): string => {
  const m = body.messages?.at(-1);
  const c = m?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? "").join(" ") : "";
};

/* ------------------------------------------ an OpenAI-compatible model */

function openAiModel(port: number, script: (body: any) => any): { url: string; seen: Seen; stop: () => void } {
  const seen: Seen = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock-director" }] });
      if (url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as any;
        seen.push({ headers: Object.fromEntries(req.headers), body });
        if (lastText(body).includes("Say OK.")) return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
        if (body.messages?.[0]?.content === "SLOW") await Bun.sleep(5000);
        return Response.json(script(body));
      }
      return Response.json({ error: { message: "Not here." } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

/* ------------------------------------------------- an Anthropic model */

function anthropicModel(): { url: string; seen: Seen; stop: () => void } {
  const seen: Seen = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/messages") return Response.json({ error: { message: "Not here." } }, { status: 404 });
      const body = (await req.json()) as any;
      seen.push({ headers: Object.fromEntries(req.headers), body });
      if (lastText(body).includes("Say OK.")) return Response.json({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } });
      return Response.json({
        model: "claude-mock",
        content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_1", name: "render_frame", input: { time: 2 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

async function chatJob(request: ChatRequest): Promise<{ status: string; result?: ChatResponse; error?: string }> {
  const { body } = await api<{ jobId: string }>("/ai/chat", { method: "POST", body: JSON.stringify(request) });
  for (;;) {
    const job = await api<{ status: string; result?: ChatResponse; error?: string }>(`/ai/chat/${body.jobId}`);
    if (job.body.status !== "running") return job.body;
    await Bun.sleep(100);
  }
}

/** A turn that has already called a tool and seen its result, with a frame in it. */
const REQUEST: ChatRequest = {
  system: "You direct.",
  projectId: "director-check",
  tools: [{ name: "render_frame", description: "A frame.", inputSchema: { type: "object", properties: { time: { type: "number" } }, required: ["time"] } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Look at 1 s." }] },
    { role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "tool_use", id: "t1", name: "render_frame", input: { time: 1 } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "frame at 1 s" }, { type: "image", mimeType: "image/png", data: PNG }] }] },
  ],
};

async function forgetUsage() {
  const file = path.join(process.env.CUTLINE_HOME ?? path.join(homedir(), "Cutline"), "usage.jsonl");
  try {
    const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l && !l.includes('"projectId":"director-check"'));
    await writeFile(file, lines.length ? `${lines.join("\n")}\n` : "");
  } catch {
    // No log yet.
  }
}

/* -------------------------------------------------------------- serve */

if (process.argv[2] === "serve") {
  // The Director's side of a short request: say where it is, look, leave a
  // marker, look at a frame, and report. One step per model call.
  const model = openAiModel(5399, (body) => {
    const messages: any[] = body.messages;
    let from = messages.length - 1;
    while (from > 0 && !(messages[from].role === "user" && !lastText({ messages: [messages[from]] }).startsWith("The images"))) from -= 1;
    const steps = messages.slice(from).filter((m) => m.role === "assistant" && m.tool_calls).length;
    const images = messages.slice(from).some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"));
    const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    const reply = (message: any) => ({ model: "mock-director", choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 40 } });
    if (steps === 0) return reply({ content: "Looking at the project first.", tool_calls: [call("c1", "report_progress", { phase: "Source", doing: "Reading the project" }), call("c2", "get_editor_state", {})] });
    if (steps === 1) return reply({ content: null, tool_calls: [call("c3", "add_marker", { time: 1, label: "Director was here" }), call("c4", "render_frame", { time: 1, width: 480 })] });
    return reply({ content: `Done: I read the project, left a marker at **1 s** and looked at the frame there${images ? " (it arrived as an image)" : " (no image arrived)"}.` });
  });
  const put = await api<{ capabilities?: { chat?: boolean; chatMessage?: string } }>("/ai/providers/check-chat-mock", {
    method: "PUT",
    body: JSON.stringify({ name: "Scripted model (check)", baseUrl: model.url, chatModel: "mock-director" }),
  });
  console.log(put.body.capabilities?.chat ? `connected: a scripted model at ${model.url}` : `could not connect: ${put.body.capabilities?.chatMessage}`);
  const done = async () => {
    await api("/ai/providers/check-chat-mock", { method: "DELETE" });
    await forgetUsage();
    model.stop();
    console.log("disconnected");
    process.exit(0);
  };
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
  setTimeout(done, 20 * 60_000);
  await new Promise(() => {});
}

/* ---------------------------------------------------------------- run */

const openai = openAiModel(0, () => ({
  model: "mock-director",
  choices: [{
    message: {
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "render_frame", arguments: '{"time": 1.5}' } },
        { id: "call_b", type: "function", function: { name: "render_frame", arguments: "not json" } },
      ],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 64 } },
}));
const anthropic = anthropicModel();

try {
  console.log("connecting");
  const o = await api<{ capabilities?: { chat?: boolean; transcribe?: boolean } }>("/ai/providers/check-chat-openai", {
    method: "PUT",
    body: JSON.stringify({ name: "check openai", baseUrl: openai.url, chatModel: "mock-director", apiKey: "check-key-openai" }),
  });
  check("an OpenAI-compatible model probes as able to chat, and not to transcribe", o.body.capabilities?.chat === true && o.body.capabilities?.transcribe === false);
  const listed = await api<{ id: string; apiKey?: string; chatModel?: string }[]>("/ai/providers");
  check("keys never come back to the page", listed.body.every((p) => !("apiKey" in p)));
  const caps = await api<{ chat?: { providerId: string; model: string } | null }>("/ai/capabilities");
  check("the model connected last runs the Director", caps.body.chat?.providerId === "check-chat-openai" && caps.body.chat.model === "mock-director");

  console.log("\nOpenAI's shape");
  const oj = await chatJob(REQUEST);
  const sent = openai.seen.at(-1)!;
  const msgs = sent.body.messages as any[];
  check("the key goes as a bearer token, to this URL only", sent.headers.authorization === "Bearer check-key-openai");
  check("the system prompt leads", msgs[0].role === "system" && msgs[0].content === "You direct.");
  check("a tool call goes out as tool_calls with JSON arguments", msgs[2]?.tool_calls?.[0]?.function?.arguments === '{"time":1}' && msgs[2].content === "Looking");
  check("its result comes back as a tool message", msgs[3]?.role === "tool" && msgs[3].tool_call_id === "t1" && msgs[3].content === "frame at 1 s");
  check("the frame follows as the user's image, since a tool message cannot carry one",
    msgs[4]?.role === "user" && msgs[4].content?.[1]?.image_url?.url === `data:image/png;base64,${PNG}`);
  check("tools are functions with their schema", sent.body.tools?.[0]?.type === "function" && sent.body.tools[0].function.parameters.required?.[0] === "time");
  const oc = oj.result?.content ?? [];
  check("tool calls come back as tool_use blocks", oj.status === "done" && oc[0]?.type === "tool_use" && JSON.stringify((oc[0] as any).input) === '{"time":1.5}', oj.error ?? "");
  check("arguments that are not JSON are flagged, not run empty", oc[1]?.type === "tool_use" && (oc[1] as any).invalidJson === "not json");
  check("and usage is counted", oj.result?.stopReason === "tool_use" && oj.result.usage.inputTokens === 120 && oj.result.usage.cachedTokens === 64);

  console.log("\nAnthropic's shape");
  const a = await api<{ capabilities?: { chat?: boolean; transcribe?: boolean; message?: string } }>("/ai/providers/check-chat-anthropic", {
    method: "PUT",
    body: JSON.stringify({ kind: "anthropic", name: "check anthropic", baseUrl: anthropic.url, chatModel: "claude-mock", apiKey: "check-key-anthropic" }),
  });
  check("an Anthropic model probes as able to chat, and says it cannot transcribe", a.body.capabilities?.chat === true && a.body.capabilities?.transcribe === false,
    a.body.capabilities?.message ?? "");
  const aj = await chatJob(REQUEST);
  const as = anthropic.seen.at(-1)!;
  const am = as.body.messages as any[];
  check("the key goes in x-api-key, with the API version, and no bearer",
    as.headers["x-api-key"] === "check-key-anthropic" && Boolean(as.headers["anthropic-version"]) && !as.headers.authorization);
  check("the system prompt and tools are cached", as.body.system?.[0]?.cache_control?.type === "ephemeral" && as.body.tools?.[0]?.input_schema?.type === "object");
  check("a tool call and its result go as blocks", am[1]?.content?.[1]?.type === "tool_use" && am[2]?.content?.[0]?.type === "tool_result" && am[2].content[0].tool_use_id === "t1");
  check("the frame goes inside the result", am[2]?.content?.[0]?.content?.[1]?.source?.data === PNG);
  check("the conversation so far is cached for the next step", am.at(-1)?.content?.at(-1)?.cache_control?.type === "ephemeral");
  check("max_tokens is always sent", typeof as.body.max_tokens === "number");
  const ac = aj.result?.content ?? [];
  check("the reply comes back as text and a tool call", aj.status === "done" && ac[0]?.type === "text" && ac[1]?.type === "tool_use" && (ac[1] as any).name === "render_frame",
    aj.error ?? "");
  check("usage counts cache reads and writes as input", aj.result?.usage.inputTokens === 160 && aj.result.usage.cachedTokens === 50);

  console.log("\nstopping and logging");
  await api("/ai/providers/check-chat-anthropic", { method: "DELETE" });
  const slow = await api<{ jobId: string }>("/ai/chat", { method: "POST", body: JSON.stringify({ ...REQUEST, system: "SLOW" }) });
  await Bun.sleep(300);
  const started = performance.now();
  await api(`/ai/chat/${slow.body.jobId}`, { method: "DELETE" });
  let job = await api<{ status: string; error?: string }>(`/ai/chat/${slow.body.jobId}`);
  while (job.body.status === "running" && performance.now() - started < 4000) {
    await Bun.sleep(50);
    job = await api(`/ai/chat/${slow.body.jobId}`);
  }
  check("Stop ends the call on the server, not after the reply", job.body.status === "error" && performance.now() - started < 1500,
    `${job.body.error} after ${Math.round(performance.now() - started)} ms`);
  const home = process.env.CUTLINE_HOME ?? path.join(homedir(), "Cutline");
  const logged = (await readFile(path.join(home, "usage.jsonl"), "utf8").catch(() => "")).split("\n").filter((l) => l.includes('"projectId":"director-check"'));
  check("each call is logged with its tokens, by project", logged.length >= 2 && logged.some((l) => l.includes('"inputTokens":160')), `${logged.length} entries`);
} finally {
  await api("/ai/providers/check-chat-openai", { method: "DELETE" });
  await api("/ai/providers/check-chat-anthropic", { method: "DELETE" });
  await forgetUsage();
  openai.stop();
  anthropic.stop();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
