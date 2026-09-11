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
import { existsSync } from "node:fs";
import path from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import { setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import type { ToCursor } from "../src/lib/cursor-protocol";
import { TabBridge } from "./bridge";
import { CursorService, type CursorRecording } from "./cursor";
import { loadMcpToken, mcpHandler } from "./mcp";
import { DiskMediaStore, TruncatedUpload, fileResponse } from "./media";
import { BadId, DiskProjectStore, cutlineHome } from "./store";
import { SESSION_COOKIE, guard, hostGuard, localhostPairs } from "./security";

const PORT = Number(process.env.CUTLINE_PORT ?? 5311);
const WEB_PORT = Number(process.env.CUTLINE_WEB_PORT ?? 5310);
const TOKEN = process.env.CUTLINE_TOKEN ?? randomBytes(24).toString("hex");
/** Always "local" for now. It is in every path so tenancy never needs a migration. */
const WORKSPACE = "local";
/** A project is metadata, not media. Anything this large is a mistake or an attack. */
const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const DIST = path.resolve(import.meta.dir, "../dist");

const projects = new DiskProjectStore(cutlineHome(), WORKSPACE);
const media = new DiskMediaStore(cutlineHome(), WORKSPACE);
const bridge = new TabBridge();
const cursor = new CursorService();
const MCP_TOKEN = await loadMcpToken(cutlineHome());

const hosts = localhostPairs(PORT, WEB_PORT);
const origins = [WEB_PORT, PORT].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);

/** Streams an upload to disk, holding the declared length to account. */
async function upload(c: Context, target: string): Promise<Response> {
  const declared = c.req.header("content-length");
  const bytes = await media.write(target, c.req.raw.body, declared === undefined ? null : Number(declared));
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
    onClose: (_event, ws) => bridge.close(ws),
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
app.all("/mcp", mcpHandler({ bridge, media, token: MCP_TOKEN, allowedOrigins: origins }));

if (existsSync(path.join(DIST, "index.html"))) {
  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), DIST) }));
  app.get("*", async (c) => {
    const html = await Bun.file(path.join(DIST, "index.html")).text();
    return c.html(html.replace("</head>", `<meta name="cutline-token" content="${TOKEN}" /></head>`));
  });
}

const server = Bun.serve({
  fetch: app.fetch,
  websocket,
  port: PORT,
  hostname: "127.0.0.1",
  // Bun refuses bodies over 128 MB by default, which is a few minutes of screen
  // capture. Recordings are uploaded whole, so the ceiling has to be the disk.
  maxRequestBodySize: 1024 ** 4,
  // Seconds of silence before a connection is dropped; a slow disk during a
  // multi-gigabyte upload should not look like a dead client.
  idleTimeout: 255,
});
console.log(`cutline server  ${server.url}`);
console.log(`workspace       ${media.workspaceDir}`);
// The token is read from its file rather than printed, so it stays out of logs.
console.log(
  `mcp             claude mcp add --transport http cutline ${server.url}mcp --header "Authorization: Bearer $(cat ${path.join(cutlineHome(), "mcp-token")})"`,
);
