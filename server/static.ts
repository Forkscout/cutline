/**
 * Serving the built web app: from the files Vite wrote, or — in a compiled
 * binary, where there is no dist/ beside the executable — from the copies
 * embedded in it.
 *
 * Either way the page leaves with this run's token in it. That is how the
 * browser gets a token at all, and why the page itself is Host-checked.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { EMBEDDED } from "./embedded";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

const typeFor = (name: string) => TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/** True in a binary made by `scripts/package.ts`. */
export const isPackaged = Object.keys(EMBEDDED).length > 0;

export function serveApp(app: Hono, dist: string, token: string): void {
  const withToken = (html: string) => html.replace("</head>", `<meta name="cutline-token" content="${token}" /></head>`);

  if (isPackaged) {
    app.get("*", async (c) => {
      const name = new URL(c.req.url).pathname.replace(/^\/+/, "");
      const file = EMBEDDED[name];
      if (file) {
        // Vite's asset names carry a hash, so they can be kept for good.
        const cache = name.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        return new Response(Bun.file(file), { headers: { "content-type": typeFor(name), "cache-control": cache } });
      }
      const index = EMBEDDED["index.html"];
      if (!index) return c.notFound();
      return c.html(withToken(await Bun.file(index).text()));
    });
    return;
  }

  if (!existsSync(path.join(dist, "index.html"))) return;
  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), dist) }));
  app.get("*", async (c) => c.html(withToken(await Bun.file(path.join(dist, "index.html")).text())));
}
