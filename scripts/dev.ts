/**
 * `bun run dev`: the server and the web app together, sharing one token.
 *
 * The token is generated here rather than by the server so that Vite can write
 * it into the page it serves — the only place the browser can learn it, and a
 * place no other website can read.
 *
 * Vite itself runs under Node (its own shebang), not `bun --bun`. Its speed
 * comes from native bundlers either way, and the Tailwind and React plugins are
 * exercised against Node far more than against Bun — not a trade worth making
 * for a dev server.
 */

import { randomBytes } from "node:crypto";

const token = randomBytes(24).toString("hex");
const env = { ...process.env, CUTLINE_TOKEN: token };

const children = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], { env, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite"], { env, stdout: "inherit", stderr: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
// If either half dies, take the other down too — a web app with no server
// behind it looks like it works until the first save.
for (const child of children) void child.exited.then((code) => stop(code ?? 1));
