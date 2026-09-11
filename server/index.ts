/**
 * The local Cutline server, on Bun.
 *
 * One process that owns projects on disk and, in production, serves the app
 * itself — so `bun run start` is the whole product. In development Vite serves
 * the page and proxies `/api` here.
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
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { BadId, DiskProjectStore, cutlineHome } from "./store";
import { guard, hostGuard, localhostPairs } from "./security";

const PORT = Number(process.env.CUTLINE_PORT ?? 5311);
const WEB_PORT = Number(process.env.CUTLINE_WEB_PORT ?? 5310);
const TOKEN = process.env.CUTLINE_TOKEN ?? randomBytes(24).toString("hex");
/** Always "local" for now. It is in every path so tenancy never needs a migration. */
const WORKSPACE = "local";
/** A project is metadata, not media. Anything this large is a mistake or an attack. */
const MAX_PROJECT_BYTES = 20 * 1024 * 1024;
const DIST = path.resolve(import.meta.dir, "../dist");

const store = new DiskProjectStore(cutlineHome(), WORKSPACE);

const hosts = localhostPairs(PORT, WEB_PORT);
const origins = [WEB_PORT, PORT].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);

/* --------------------------------------------------------------------- api */

const api = new Hono();
api.use("*", guard({ token: TOKEN, allowedHosts: hosts, allowedOrigins: origins }));

api.get("/health", (c) => c.json({ ok: true, workspace: WORKSPACE, home: cutlineHome() }));

api.get("/projects", async (c) => c.json(await store.list()));

api.get("/projects/:id", async (c) => {
  const json = await store.get(c.req.param("id"));
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

  await store.put(id, body);
  return c.json({ ok: true });
});

api.delete("/projects/:id", async (c) => {
  await store.remove(c.req.param("id"));
  return c.json({ ok: true });
});

api.onError((err, c) => {
  if (err instanceof BadId) return c.json({ error: err.message }, 400);
  if (err instanceof SyntaxError) return c.json({ error: "Body is not valid JSON" }, 400);
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

if (existsSync(path.join(DIST, "index.html"))) {
  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), DIST) }));
  app.get("*", async (c) => {
    const html = await Bun.file(path.join(DIST, "index.html")).text();
    return c.html(html.replace("</head>", `<meta name="cutline-token" content="${TOKEN}" /></head>`));
  });
}

const server = Bun.serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
console.log(`cutline server  ${server.url}`);
console.log(`projects        ${path.join(cutlineHome(), "workspaces", WORKSPACE, "projects")}`);
