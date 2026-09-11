/**
 * Runs one of the browser harnesses in headless Chrome and streams its log.
 *
 *   bun scripts/headless-check.ts dev-stress-check.html?seconds=600
 *   bun scripts/headless-check.ts dev-editor-check.html
 *
 * The harnesses refuse to measure in a background tab, because a hidden tab
 * throttles timers and suspends rAF and every number comes out wrong while
 * still looking like a result. Headless Chrome is visible to the page, so this
 * is how to take those measurements without keeping a window in front — and
 * how to run a genuinely long take unattended.
 *
 * Needs `bun run dev`. Uses a throwaway profile, never the user's own.
 * CHROME=/path/to/chrome to use another binary.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const [page, timeoutMinutes = "60"] = process.argv.slice(2);
if (!page) throw new Error("usage: bun scripts/headless-check.ts <harness page> [timeout minutes]");
const url = `http://localhost:5310/${page.replace(/^\//, "")}`;
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const profile = await mkdtemp(path.join(tmpdir(), "cutline-headless-"));

const chrome = Bun.spawn(
  [
    chromePath,
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    // Otherwise an AudioContext stays suspended with no gesture, and the
    // synthetic microphone records zero bytes.
    "--autoplay-policy=no-user-gesture-required",
    // Lets a harness force a collection, so heap figures mean what is held.
    "--js-flags=--expose-gc",
    "--window-size=1440,900",
    url,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

type Target = { type: string; url: string; webSocketDebuggerUrl: string };
let target: Target | undefined;
for (let i = 0; i < 100 && !target; i += 1) {
  try {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[];
    target = list.find((t) => t.type === "page" && t.url.startsWith("http://localhost:5310"));
  } catch {
    // Not listening yet.
  }
  if (!target) await Bun.sleep(200);
}

let exitCode = 1;
try {
  if (!target) throw new Error("Headless Chrome did not open the page. Is `bun run dev` running?");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<number, (result: unknown) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
    if (message.id !== undefined) {
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve) => (ws.onopen = resolve));
  const evaluate = (expression: string) =>
    new Promise<unknown>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });

  const deadline = Date.now() + Number(timeoutMinutes) * 60_000;
  let seen = "";
  while (Date.now() < deadline) {
    const reply = (await evaluate('document.getElementById("log")?.innerText ?? ""')) as {
      result?: { value?: string };
    };
    const text = reply?.result?.value ?? "";
    if (text.length > seen.length) {
      process.stdout.write(text.slice(seen.length));
      seen = text;
    }
    if (/all checks passed/.test(text)) {
      exitCode = 0;
      break;
    }
    if (/check\(s\) failed|threw:/.test(text)) break;
    await Bun.sleep(3000);
  }
  if (Date.now() >= deadline) console.log(`\n[headless] gave up after ${timeoutMinutes} min`);
  ws.close();
} finally {
  chrome.kill();
  await chrome.exited;
  await rm(profile, { recursive: true, force: true });
}
process.exit(exitCode);
