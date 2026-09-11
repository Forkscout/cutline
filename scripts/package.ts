/**
 * Single binaries: the server, the built web app inside it, nothing else to
 * install.
 *
 *   bun scripts/package.ts               for this machine
 *   bun scripts/package.ts --all         every target below
 *   bun scripts/package.ts --skip-build  use the dist/ already built
 *
 * `bun build --compile` embeds files imported with `{ type: "file" }`, so this
 * writes server/embedded.ts from what Vite built, compiles, and puts the empty
 * module back — a stale one would make `bun run dev` serve yesterday's app.
 *
 * The binary keeps everything in ~/Cutline, as the server always does, and
 * listens on 127.0.0.1:5311 unless CUTLINE_HOST and CUTLINE_PORT say otherwise.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGETS: Record<string, string> = {
  "macos-arm64": "bun-darwin-arm64",
  "macos-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64",
};

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
const embedded = path.join(root, "server", "embedded.ts");
const empty = await readFile(embedded, "utf8");

const args = process.argv.slice(2);
const hostTarget = `bun-${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const targets = args.includes("--all")
  ? Object.entries(TARGETS)
  : [(Object.entries(TARGETS).find(([, target]) => target === hostTarget) ?? ["this-machine", hostTarget]) as [string, string]];

async function filesIn(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await filesIn(path.join(dir, entry.name), name)));
    else out.push(name);
  }
  return out;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`);
}

if (!args.includes("--skip-build")) {
  console.log("building the web app…");
  await run(["bunx", "--bun", "vite", "build"]);
}

const names = (await filesIn(dist)).sort();
if (names.length === 0) throw new Error("dist/ is empty — build the web app first.");
console.log(`embedding ${names.length} files`);
await writeFile(
  embedded,
  [
    "// Written by scripts/package.ts while packaging. The repo keeps the empty one.",
    ...names.map((name, i) => `import f${i} from "../dist/${name}" with { type: "file" };`),
    "",
    "export const EMBEDDED: Record<string, string> = {",
    ...names.map((name, i) => `  ${JSON.stringify(name)}: f${i},`),
    "};",
    "",
  ].join("\n"),
);

try {
  for (const [label, target] of targets) {
    const out = path.join(root, "out", `cutline-${label}${target.includes("windows") ? ".exe" : ""}`);
    console.log(`compiling ${label}…`);
    await run(["bun", "build", "--compile", `--target=${target}`, "server/index.ts", "--outfile", out]);
    console.log(`  ${path.relative(root, out)}  ${((await stat(out)).size / 1e6).toFixed(0)} MB`);
  }
} finally {
  await writeFile(embedded, empty);
}

console.log("\nRun one: it serves http://127.0.0.1:5311 and keeps projects, recordings and media in ~/Cutline.");
