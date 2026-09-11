/**
 * The built web app, embedded in a compiled binary.
 *
 * `bun build --compile` embeds any file imported with `{ type: "file" }`, so
 * `scripts/package.ts` writes this module from what Vite built, compiles, and
 * puts this empty one back. Empty means "serve dist/ from disk", which is what
 * `bun run dev` and `bun run start` do — a stale copy here would make the dev
 * server hand out yesterday's app.
 */

export const EMBEDDED: Record<string, string> = {};
