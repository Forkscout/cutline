/**
 * The local Cutline server, on Bun.
 *
 * One process that owns projects, recordings and imported media on disk and,
 * in production, serves the app itself — so `bun run start` is the whole
 * product. In development Vite serves the page and proxies `/api` here.
 *
 * Bun rather than Node for the parts that are genuinely better: TypeScript runs
 * without a build step, WebSockets are built in (the agent's live edits will
 * need them), and Hono is native to it. None of this makes the editor faster —
 * the heavy work happens in the browser — and nobody should expect it to.
 *
 * It binds to 127.0.0.1 only. Listening on every interface would put the
 * user's projects on the local network, and nothing in this design assumes
 * that.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import type { ToCursor } from "../src/lib/cursor-protocol";
import { TabBridge } from "./bridge";
import { CursorService, type CursorRecording } from "./cursor";
import { Remuxer } from "./remux";
import { AiSettings, isLocal, type Provider, type ProviderKind } from "./ai";
import { probeAll, recordUsage, runChat } from "./chat";
import type { ChatRequest } from "../src/lib/chat-protocol";
import { PROVIDER_KINDS } from "./stt";
import { Jobs, transcribeFile } from "./transcribe";
import { loadMcpToken, mcpHandler, rotateMcpToken } from "./mcp";
import { AgentSettings } from "./agents";
import { DiskMediaStore, TruncatedUpload, fileResponse } from "./media";
import { BadFileName, WorkspaceStore, isWorkspaceKind } from "./workspace";
import { BadId, DiskProjectStore, assertSafeId, cutlineHome } from "./store";
import { SESSION_COOKIE, guard, hostGuard, localhostPairs } from "./security";
import { serveApp } from "./static";

const PORT = Number(process.env.CUTLINE_PORT ?? 5311);
const WEB_PORT = Number(process.env.CUTLINE_WEB_PORT ?? 5310);
/**
 * Where to listen. 127.0.0.1 outside a container. Inside one it must be
 * 0.0.0.0 to be reachable at all, and the publish rule (127.0.0.1:5311:5311 in
 * compose.yaml) is then what keeps it off the network.
 */
const LISTEN = process.env.CUTLINE_HOST ?? "127.0.0.1";
/** The port the browser uses, when a container maps the server to another one. */
const PUBLIC_PORT = Number(process.env.CUTLINE_PUBLIC_PORT ?? PORT);
const TOKEN = process.env.CUTLINE_TOKEN ?? randomBytes(24).toString("hex");
/** Always "local" for now. It is in every path so tenancy never needs a migration. */
const WORKSPACE = "local";
/** A project is metadata, not media. Anything this large is a mistake or an attack. */
const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const DIST = path.resolve(import.meta.dir, "../dist");

const projects = new DiskProjectStore(cutlineHome(), WORKSPACE);
const workspace = new WorkspaceStore(cutlineHome(), WORKSPACE);
const media = new DiskMediaStore(cutlineHome(), WORKSPACE);
const bridge = new TabBridge();
const cursor = new CursorService();
const remuxer = new Remuxer();
const ai = new AiSettings(cutlineHome());
const jobs = new Jobs();
let mcpToken = await loadMcpToken(cutlineHome());
const agents = new AgentSettings(cutlineHome());

const ports = [...new Set([PORT, WEB_PORT, PUBLIC_PORT])];
const hosts = localhostPairs(...ports);
const origins = ports.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);

/**
 * Streams an upload to disk, holding the declared length to account. With
 * `?upload=<id>&at=<byte>` it is one piece of a positional upload instead, and
 * `&final=1` completes it (see `DiskMediaStore.writeAt`).
 */
async function upload(c: Context, target: string): Promise<Response> {
  const declared = c.req.header("content-length");
  const expected = declared === undefined ? null : Number(declared);
  const uploadId = c.req.query("upload");
  if (uploadId !== undefined) {
    const at = Number(c.req.query("at") ?? "0");
    if (!Number.isSafeInteger(at) || at < 0) return c.json({ error: "Bad position" }, 400);
    const bytes = await media.writeAt(target, uploadId, c.req.raw.body, expected, at, c.req.query("final") === "1");
    return c.json({ ok: true, bytes });
  }
  const bytes = await media.write(target, c.req.raw.body, expected);
  return c.json({ ok: true, bytes });
}

/* --------------------------------------------------------------------- api */

const api = new Hono();
api.use("*", guard({ token: TOKEN, allowedHosts: hosts, allowedOrigins: origins }));

api.get("/health", (c) => c.json({ ok: true, workspace: WORKSPACE, home: cutlineHome() }));

/**
 * Trades the header token for a cookie.
 *
 * `<video>`, `<img>` and mediabunny's range reads all fetch media without a way
 * to add headers, so they need the secret some other way. Only a caller that
 * already holds the token can reach this route, the cookie is HttpOnly so no
 * script can read it back out, and SameSite=Strict keeps it off every request a
 * foreign site's page might make.
 */
api.post("/session", (c) => {
  setCookie(c, SESSION_COOKIE, TOKEN, { httpOnly: true, sameSite: "Strict", path: "/api" });
  return c.json({ ok: true });
});

api.get("/usage", async (c) => c.json(await media.usage()));

/**
 * The editor tab's end of the agent bridge. Behind the same guard as the rest
 * of /api — a WebSocket upgrade carries the session cookie and an Origin, so a
 * foreign page can no more open one than it can call any other route.
 */
api.get(
  "/bridge",
  upgradeWebSocket(() => ({
    onMessage: (event, ws) => bridge.message(ws, String(event.data)),
    onClose: (event, ws) => bridge.close(ws, event.code),
  })),
);

/* --- projects --- */

api.get("/projects", async (c) => c.json(await projects.list()));

api.get("/projects/:id", async (c) => {
  const json = await projects.get(c.req.param("id"));
  if (json === null) return c.json({ error: "No such project" }, 404);
  return c.body(json, 200, { "content-type": "application/json" });
});

api.put("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.text();
  if (body.length > MAX_PROJECT_BYTES) return c.json({ error: "Project too large" }, 413);

  // The id in the URL and the id in the document must agree. Otherwise one
  // project can be written under another's name, and the next open shows the
  // wrong edit with no error anywhere.
  const parsed = JSON.parse(body) as { project?: { id?: string }; id?: string };
  const documentId = parsed.project?.id ?? parsed.id;
  if (documentId !== id) return c.json({ error: "Project id does not match the URL" }, 400);

  await projects.put(id, body);
  return c.json({ ok: true });
});

api.delete("/projects/:id", async (c) => {
  await projects.remove(c.req.param("id"));
  return c.json({ ok: true });
});

/* Versions: named snapshots beside a project. Restoring one is an edit in the tab, so History can undo it. */

api.get("/projects/:id/versions", async (c) => c.json(await projects.listVersions(c.req.param("id"))));

api.get("/projects/:id/versions/:vid", async (c) => {
  const json = await projects.getVersion(c.req.param("id"), c.req.param("vid"));
  if (json === null) return c.json({ error: "No such version" }, 404);
  return c.body(json, 200, { "content-type": "application/json" });
});

api.post("/projects/:id/versions", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.text();
  if (body.length > MAX_PROJECT_BYTES) return c.json({ error: "Project too large" }, 413);
  const parsed = JSON.parse(body) as { label?: string; version?: number; project?: { id?: string } };
  if (parsed.project?.id !== id) return c.json({ error: "Project id does not match the URL" }, 400);
  return c.json(await projects.putVersion(id, parsed.label ?? "", JSON.stringify({ version: parsed.version, project: parsed.project })));
});

/* --- agents: what they may do, who has connected, and what it all cost --- */

const shownAgentHome = () => process.env.CUTLINE_HOME_DISPLAY ?? cutlineHome();
const registrationLine = (url: string) =>
  `claude mcp add --transport http cutline ${new URL(url).origin}/mcp --header "Authorization: Bearer $(cat ${path.join(shownAgentHome(), "mcp-token")})"`;

api.get("/agents", async (c) => {
  const seen = agents.clients();
  return c.json({
    registration: registrationLine(c.req.url),
    tokenFile: path.join(shownAgentHome(), "mcp-token"),
    tokenTail: mcpToken.slice(-4),
    permissions: await agents.permissions(),
    clients: seen.clients,
    since: seen.since,
    editors: bridge.editors(),
  });
});

api.post("/agents/permissions", async (c) => c.json(await agents.setPermissions(await c.req.json())));

/** A new token. Every agent registered with the old one stops working, which is the point. */
api.post("/agents/token", async (c) => {
  mcpToken = await rotateMcpToken(cutlineHome());
  return c.json({ registration: registrationLine(c.req.url), tokenTail: mcpToken.slice(-4) });
});

api.get("/agents/usage", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  return c.json(await agents.usage(Number.isFinite(days) ? Math.min(365, Math.max(1, days)) : 30));
});

/* --- the workspace: brand kits, looks, recipes, references --- */

/** One route set for the four kinds: they differ in what they hold, not in how they are kept. */
api.get("/workspace/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!isWorkspaceKind(kind)) return c.json({ error: "No such kind" }, 404);
  return c.json(await workspace.list(kind));
});

api.get("/workspace/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  if (!isWorkspaceKind(kind)) return c.json({ error: "No such kind" }, 404);
  const doc = await workspace.get(kind, c.req.param("id"));
  return doc ? c.json(doc) : c.json({ error: "Not found" }, 404);
});

api.put("/workspace/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  if (!isWorkspaceKind(kind)) return c.json({ error: "No such kind" }, 404);
  const body = await c.req.text();
  if (body.length > MAX_PROJECT_BYTES) return c.json({ error: "Too large" }, 413);
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return c.json({ error: "Send a JSON object" }, 400);
  return c.json(await workspace.put(kind, c.req.param("id"), parsed as Record<string, unknown>));
});

api.delete("/workspace/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  if (!isWorkspaceKind(kind)) return c.json({ error: "No such kind" }, 404);
  await workspace.remove(kind, c.req.param("id"));
  return c.json({ ok: true });
});

api.on(["GET", "HEAD"], "/workspace/:kind/:id/files/:name", async (c) => {
  const kind = c.req.param("kind");
  if (!isWorkspaceKind(kind)) return c.json({ error: "No such kind" }, 404);
  try {
    return await fileResponse(await workspace.file(kind, c.req.param("id"), c.req.param("name")), c.req.method, c.req.header("range"));
  } catch (err) {
    if (err instanceof BadFileName) return c.json({ error: err.message }, 400);
    throw err;
  }
});

api.put("/workspace/:kind/:id/files/:name", async (c) => {
  const kind = c.req.param("kind");
  if (!isWorkspaceKind(kind)) return c.json({ error: "No such kind" }, 404);
  try {
    return await upload(c, await workspace.file(kind, c.req.param("id"), c.req.param("name"), true));
  } catch (err) {
    if (err instanceof BadFileName) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/* --- recordings --- */

api.get("/recordings", async (c) => c.json(await media.listSessions()));

api.delete("/recordings/:sid", async (c) => {
  await media.deleteSession(c.req.param("sid"));
  return c.json({ ok: true });
});

api.on(["GET", "HEAD"], "/recordings/:sid/files/:name", (c) =>
  fileResponse(
    media.recordingFile(c.req.param("sid"), c.req.param("name")),
    c.req.method,
    c.req.header("range"),
  ),
);

/**
 * Remuxes one of a take's files into an indexed copy, file to file, on a
 * worker — so an hour-long take never passes through the browser's memory.
 */
api.post("/recordings/:sid/remux", async (c) => {
  const sid = c.req.param("sid");
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  const source = media.recordingFile(sid, from);
  const target = media.recordingFile(sid, to);
  const size = await media.size(source);
  if (size === null) return c.json({ error: "No such file" }, 404);
  // 422, not 500: an empty or damaged file fails exactly the same way in the
  // page, so the caller must report it rather than retry the remux there.
  if (size === 0) return c.json({ error: `${from} is empty — nothing was recorded on that track.` }, 422);
  const started = performance.now();
  try {
    const bytes = await remuxer.remux(source, target);
    return c.json({ ok: true, bytes, ms: Math.round(performance.now() - started) });
  } catch (err) {
    return c.json({ error: `${from} could not be read (${err instanceof Error ? err.message : String(err)}).` }, 422);
  }
});

api.put("/recordings/:sid/files/:name", (c) =>
  upload(c, media.recordingFile(c.req.param("sid"), c.req.param("name"))),
);

/* --- imported media --- */

api.on(["GET", "HEAD"], "/media/:id", (c) =>
  fileResponse(media.mediaFile(c.req.param("id")), c.req.method, c.req.header("range")),
);

api.put("/media/:id", (c) => upload(c, media.mediaFile(c.req.param("id"))));

api.delete("/media/:id", async (c) => {
  await media.deleteMedia(c.req.param("id"));
  return c.json({ ok: true });
});

/* --- cursor track --- */

/**
 * Opened by the recorder page for the length of a take. The socket's lifetime
 * is the sampler's: a tab that dies mid-take closes it, and the sampler stops
 * with whatever it had already written.
 */
api.get(
  "/cursor",
  upgradeWebSocket(() => {
    let recording: CursorRecording | null = null;
    const reply = (ws: WSContext, message: unknown) => ws.send(JSON.stringify(message));
    return {
      onMessage: async (event, ws) => {
        let message: ToCursor;
        try {
          message = JSON.parse(String(event.data)) as ToCursor;
        } catch {
          return;
        }
        try {
          if (message.type === "start") {
            const file = media.recordingFile(message.sessionId, "cursor.jsonl");
            recording = await cursor.start(file, message.originWall, message.capture ?? {});
            reply(ws, { type: "started" });
          } else if (message.type === "pause") {
            recording?.pause(message.wall);
          } else if (message.type === "resume") {
            recording?.resume(message.wall);
          } else if (message.type === "stop") {
            const samples = recording ? await cursor.stop(recording) : 0;
            recording = null;
            reply(ws, { type: "stopped", samples });
          } else if (message.type === "discard") {
            if (recording) await cursor.discard(recording);
            recording = null;
            reply(ws, { type: "stopped", samples: 0 });
          }
        } catch (err) {
          reply(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      },
      onClose: () => {
        if (recording) void cursor.stop(recording);
        recording = null;
      },
    };
  }),
);

/* --- AI services --- */

api.get("/ai/providers", async (c) => c.json(await ai.list()));

/**
 * Adds or edits a provider, then probes it — the answer is what it can do,
 * not merely whether it answered.
 */
api.put("/ai/providers/:id", async (c) => {
  const id = c.req.param("id");
  assertSafeId(id);
  const body = await c.req.json<{
    kind?: ProviderKind;
    name?: string;
    baseUrl?: string;
    transcribeModel?: string;
    chatModel?: string;
    apiKey?: string;
  }>();
  if (body.kind !== undefined && !PROVIDER_KINDS.includes(body.kind)) {
    return c.json({ error: `kind must be one of ${PROVIDER_KINDS.join(", ")}` }, 400);
  }
  let url: URL;
  try {
    url = new URL(body.baseUrl ?? "");
  } catch {
    return c.json({ error: "The base URL is not a URL." }, 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return c.json({ error: "The base URL must be http or https." }, 400);
  const provider = await ai.upsert(id, {
    ...(body.kind ? { kind: body.kind } : {}),
    name: body.name?.trim() || url.host,
    baseUrl: url.toString(),
    ...(body.transcribeModel ? { transcribeModel: body.transcribeModel } : {}),
    ...(body.chatModel !== undefined ? { chatModel: body.chatModel } : {}),
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
  });
  return c.json(await ai.setCapabilities(id, await probeAll(provider)));
});

api.post("/ai/providers/:id/probe", async (c) => {
  const provider = await ai.get(c.req.param("id"));
  if (!provider) return c.json({ error: "No such provider" }, 404);
  return c.json(await ai.setCapabilities(provider.id, await probeAll(provider)));
});

api.delete("/ai/providers/:id", async (c) => {
  await ai.remove(c.req.param("id"));
  return c.json({ ok: true });
});

/** Which service each capability resolves to right now, and whether it stays on this machine. */
api.get("/ai/capabilities", async (c) => {
  const [transcriber, director] = await Promise.all([ai.resolveTranscribe(), ai.resolveChat()]);
  const view = (p: Provider, model: string) => ({ providerId: p.id, kind: p.kind, name: p.name, model, local: isLocal(p.baseUrl) });
  return c.json({
    transcribe: transcriber ? view(transcriber, transcriber.transcribeModel) : null,
    chat: director?.chatModel ? view(director, director.chatModel) : null,
  });
});

/* --- the Director's model calls --- */

const chatJobs = new Jobs();
const chatAborts = new Map<string, AbortController>();
const USAGE_FILE = path.join(cutlineHome(), "usage.jsonl");

/**
 * One model call for the Director, answered with a job to poll — a reply with
 * a dozen tool calls can outlast a request — and logged to usage.jsonl.
 */
api.post("/ai/chat", async (c) => {
  const body = await c.req.json<ChatRequest>();
  if (typeof body.system !== "string" || !Array.isArray(body.messages) || !Array.isArray(body.tools)) {
    return c.json({ error: "system, messages and tools are required" }, 400);
  }
  const provider = await ai.resolveChat();
  if (!provider) return c.json({ error: "No model is connected for the Director." }, 409);
  const controller = new AbortController();
  let id = "";
  id = chatJobs.start(async () => {
    try {
      const result = await runChat(provider, body, controller.signal);
      await recordUsage(USAGE_FILE, {
        at: Date.now(),
        kind: "chat",
        providerId: provider.id,
        provider: provider.name,
        model: result.model,
        projectId: typeof body.projectId === "string" ? body.projectId : null,
        ...result.usage,
      }).catch(() => {});
      return result;
    } finally {
      chatAborts.delete(id);
    }
  });
  chatAborts.set(id, controller);
  return c.json({ jobId: id });
});

api.get("/ai/chat/:jobId", (c) => {
  const job = chatJobs.get(c.req.param("jobId"));
  return job ? c.json(job) : c.json({ error: "No such job" }, 404);
});

/** Stop: the page's Stop button, so a long reply is not paid for to the end. */
api.delete("/ai/chat/:jobId", (c) => {
  chatAborts.get(c.req.param("jobId"))?.abort();
  return c.json({ ok: true });
});

/* --- transcription --- */

/**
 * Starts transcribing a take's file or an imported file, and answers with a
 * job to poll: an hour of audio outlasts any request timeout.
 */
api.post("/transcribe", async (c) => {
  const body = await c.req.json<{
    sessionId?: string;
    fileName?: string;
    mediaId?: string;
    language?: string;
    force?: boolean;
    chunkSeconds?: number;
  }>();
  const source = body.mediaId
    ? media.mediaFile(body.mediaId)
    : media.recordingFile(body.sessionId ?? "", body.fileName ?? "");
  const cache = body.mediaId
    ? media.mediaFile(`${body.mediaId}.transcript.json`)
    : media.recordingFile(body.sessionId ?? "", `${body.fileName}.transcript.json`);
  if ((await media.size(source)) === null) return c.json({ error: "No such file" }, 404);
  let provider = await ai.resolveTranscribe();
  if (!provider) return c.json({ error: "No transcription service is connected." }, 409);
  // A local service connected before whisper.cpp was told apart carries no
  // flavor, and would get none of its handling. Probing it again is free.
  if (provider.kind === "openai" && !provider.capabilities?.flavor && isLocal(provider.baseUrl)) {
    const capabilities = await probeAll(provider);
    await ai.setCapabilities(provider.id, capabilities);
    provider = { ...provider, capabilities };
  }
  if (body.language !== undefined && !/^[a-z]{2,3}$/.test(body.language)) {
    return c.json({ error: "language must be an ISO 639 code, like hi or en" }, 400);
  }
  const jobId = jobs.start(async (progress) => {
    const started = Date.now();
    const transcript = await transcribeFile(source, cache, provider, {
      ...(body.language ? { language: body.language } : {}),
      ...(body.chunkSeconds ? { chunkSeconds: body.chunkSeconds } : {}),
      force: Boolean(body.force),
      onProgress: progress,
    });
    // Only what was actually transcribed: a cached transcript costs nothing.
    if (transcript.createdAt >= started) {
      await recordUsage(USAGE_FILE, {
        at: Date.now(),
        kind: "transcribe",
        providerId: provider!.id,
        provider: provider!.name,
        model: provider!.transcribeModel,
        seconds: Math.round(transcript.durationSec),
      }).catch(() => {});
    }
    return transcript;
  });
  return c.json({ jobId });
});

api.get("/transcribe/:jobId", (c) => {
  const job = jobs.get(c.req.param("jobId"));
  return job ? c.json(job) : c.json({ error: "No such job" }, 404);
});

/* --- exports --- */

api.get("/exports", async (c) => c.json(await media.listExports()));

api.on(["GET", "HEAD"], "/exports/:name", (c) =>
  fileResponse(media.exportFile(c.req.param("name")), c.req.method, c.req.header("range")),
);

api.put("/exports/:name", async (c) => {
  const target = media.exportFile(c.req.param("name"));
  // An export is a delivery. Overwriting one the user may already have sent
  // somewhere is never what anyone meant, so a name that exists is refused.
  if ((await media.size(target)) !== null) return c.json({ error: "An export with that name already exists" }, 409);
  const declared = c.req.header("content-length");
  const bytes = await media.write(target, c.req.raw.body, declared === undefined ? null : Number(declared));
  return c.json({ ok: true, bytes, path: target });
});

api.onError((err, c) => {
  if (err instanceof BadId) return c.json({ error: err.message }, 400);
  if (err instanceof SyntaxError) return c.json({ error: "Body is not valid JSON" }, 400);
  if (err instanceof TruncatedUpload) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

/* --------------------------------------------------------------------- app */

const app = new Hono();
// Host is checked on everything, the page included. The page is how the token
// is delivered, and a DNS-rebinding attacker who could fetch it same-origin
// would read the token straight out of it.
app.use("*", hostGuard(hosts));
app.route("/api", api);
app.all("/mcp", mcpHandler({ bridge, media, workspace, agents, token: () => mcpToken, allowedOrigins: origins }));

serveApp(app, DIST, TOKEN);

const server = Bun.serve({
  fetch: app.fetch,
  websocket,
  port: PORT,
  hostname: LISTEN,
  // Bun refuses bodies over 128 MB by default, which is a few minutes of screen
  // capture. Recordings are uploaded whole, so the ceiling has to be the disk.
  maxRequestBodySize: 1024 ** 4,
  // Seconds of silence before a connection is dropped; a slow disk during a
  // multi-gigabyte upload should not look like a dead client.
  idleTimeout: 255,
});
// In a container the server's own URL and home are not the ones the user
// types: it listens on 0.0.0.0 and its home is a mount of ~/Cutline.
const shownUrl = LISTEN === "0.0.0.0" || LISTEN === "::" ? `http://127.0.0.1:${PUBLIC_PORT}/` : server.url.href;
const shownHome = process.env.CUTLINE_HOME_DISPLAY ?? cutlineHome();
console.log(`cutline server  ${shownUrl}`);
console.log(`workspace       ${media.workspaceDir}`);
// The token is read from its file rather than printed, so it stays out of logs.
console.log(
  `mcp             claude mcp add --transport http cutline ${shownUrl}mcp --header "Authorization: Bearer $(cat ${path.join(shownHome, "mcp-token")})"`,
);
