/**
 * Exercises the whole recording path without a single permission prompt.
 *
 * A canvas stream and an oscillator are indistinguishable from a camera and a
 * microphone as far as MediaRecorder is concerned, so this covers the parts
 * that actually break: chunk ordering, the worker's sync access handle, the
 * offsets, pause accounting, and reading the files back off disk.
 *
 * Open /dev-check.html to run it.
 */

import type { ArmedSource } from "./recorder/types";
import { RecordingSession } from "./recorder/session";
import { CursorCapture } from "./lib/cursor-capture";
import { discardTake, findInterruptedTakes, probeDurationMs, recoverTake } from "./recorder/recover";
import { listLocalSessionIds } from "./recorder/storage";
import { deleteSession as deleteServerSession, sessionFileUrl } from "./lib/media-store";
import { api, startSession } from "./lib/server";
// The recorder is tested against its own capture buffer, before any sync.
import {
  deleteLocalSession as deleteSession,
  getLocalTrackFile as getTrackFile,
  listLocalSessions as listSessions,
} from "./recorder/storage";

const out = document.getElementById("log")!;
const log = (msg: string, cls = "") => {
  out.innerHTML += cls ? `<span class="${cls}">${msg}</span>\n` : `${msg}\n`;
};

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`, pass ? "ok" : "bad");
}

function syntheticVideo(
  kind: "screen" | "camera",
  width: number,
  height: number,
): ArmedSource {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  // Something must actually change per frame, or the encoder emits almost
  // nothing and a broken write path would look identical to a working one.
  //
  // Driven by setInterval rather than requestAnimationFrame: rAF is suspended
  // entirely while the tab is hidden, which would silently turn this fixture
  // into a black stream and blame the recorder for it.
  const draw = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${((frame * 7) + (kind === "camera" ? 180 : 0)) % 360} 70% 45%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.round(height / 6)}px monospace`;
    ctx.fillText(`${kind} ${frame}`, 20, height / 2);
  };
  draw();
  setInterval(draw, 1000 / 15);
  return {
    id: crypto.randomUUID(),
    kind,
    label: `synthetic ${kind}`,
    stream: canvas.captureStream(15),
    ended: false,
  };
}

function syntheticAudio(): ArmedSource {
  const context = new AudioContext();
  const osc = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.2;
  const dest = context.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.frequency.value = 440;
  osc.start();
  return {
    id: crypto.randomUUID(),
    kind: "microphone",
    label: "synthetic tone",
    stream: dest.stream,
    ended: false,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- simulating a crashed tab */

async function sessionDir(id: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle("recordings")).getDirectoryHandle(id);
}

async function removeLocalFile(id: string, name: string): Promise<void> {
  await (await sessionDir(id)).removeEntry(name);
}

/** Cuts the tail off a file — what a tab dying mid-chunk leaves behind. */
async function truncateLocalFile(id: string, name: string, bytes: number): Promise<void> {
  const handle = await (await sessionDir(id)).getFileHandle(name);
  const size = (await handle.getFile()).size;
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.truncate(Math.max(0, size - bytes));
  await writable.close();
}

async function run() {
  // ?keep builds a three-source take so the editor has a screen, a camera and
  // an audio track to lay out — the shape it is actually designed for.
  const keep = new URLSearchParams(location.search).has("keep");
  const sources = keep
    ? [syntheticVideo("screen", 1280, 720), syntheticVideo("camera", 480, 480), syntheticAudio()]
    : [syntheticVideo("camera", 320, 240), syntheticAudio()];
  log(`arming ${sources.length} synthetic sources…`);

  // The cursor track travels over a WebSocket, which authenticates with the
  // session cookie rather than the header token.
  await startSession();
  const session = await RecordingSession.prepare(sources, { name: "pipeline check" });
  check("session prepared", session.trackCount === sources.length, `${session.trackCount} tracks`);

  // Timers are not punctual — a hidden tab clamps them to one second — so the
  // take is measured rather than assumed, and the assertions below compare the
  // recorded duration against what the wall clock actually did.
  const wallStart = performance.now();
  session.start();
  const cursor = await CursorCapture.start(session.id, session.clockOriginWall, { surface: "monitor" });
  await wait(2500);
  session.pause();
  cursor?.pause();
  const pauseStart = performance.now();
  log("pausing…");
  await wait(600);
  session.resume();
  cursor?.resume();
  const pausedFor = performance.now() - pauseStart;
  await wait(1500);
  const wallTotal = performance.now() - wallStart;

  const meta = await session.stop();
  const cursorSamples = await cursor?.stop();
  log(`wall clock ${Math.round(wallTotal)}ms, of which ${Math.round(pausedFor)}ms paused`);
  log(`\nsession ${meta.id}`);
  log(JSON.stringify(meta, null, 2));

  check("all tracks written", meta.tracks.length === sources.length);
  check(
    "tracks share the clock",
    meta.tracks.every((t) => t.offsetMs < 50),
    `offsets ${meta.tracks.map((t) => `${t.offsetMs}ms`).join(", ")}`,
  );
  const expected = wallTotal - pausedFor;
  check(
    "paused time excluded from duration",
    meta.tracks.every((t) => Math.abs(t.durationMs - expected) < 250),
    `expected ~${Math.round(expected)}ms, got ${meta.tracks.map((t) => `${t.durationMs}ms`).join(", ")}`,
  );
  check(
    "pause recorded",
    meta.tracks.every(
      (t) => t.pauses.length === 1 && Math.abs((t.pauses[0]?.ms ?? 0) - pausedFor) < 250,
    ),
    `${meta.tracks.map((t) => `${t.pauses[0]?.ms}ms`).join(", ")} vs ${Math.round(pausedFor)}ms`,
  );
  check(
    "bytes on disk",
    meta.tracks.every((t) => t.bytes > 1024),
    meta.tracks.map((t) => `${t.fileName} ${t.bytes}B`).join(", "),
  );
  check(
    "video file declares no phantom audio track",
    meta.tracks.find((t) => t.kind === "camera")?.mimeType.includes("opus") === false,
    meta.tracks.find((t) => t.kind === "camera")?.mimeType ?? "",
  );

  for (const track of meta.tracks) {
    const file = await getTrackFile(meta.id, track.fileName);
    check(
      `${track.fileName} reads back at the recorded size`,
      file.size === track.bytes,
      `${file.size} vs ${track.bytes}`,
    );
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    // 0x1A45DFA3 is the EBML magic every WebM file starts with. If the worker
    // wrote chunks out of order this is the first thing that breaks.
    check(
      `${track.fileName} is a well-formed WebM header`,
      head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3,
      [...head].map((b) => b.toString(16)).join(" "),
    );
  }

  /* --- the cursor track, sampled by the server on the same clock ------- */
  if (!cursor) {
    log("cursor track skipped — the server does not sample the cursor on this platform", "dim");
  } else {
    const text = await (await api(sessionFileUrl(meta.id, "cursor.jsonl"))).text();
    const [headerLine, ...rows] = text.trim().split("\n");
    const header = JSON.parse(headerLine ?? "{}") as { screens?: unknown[]; originWall?: number };
    const samples = rows.map((r) => JSON.parse(r) as [number, number, number, number]);
    const times = samples.map((s) => s[0]);
    const recorded = Math.max(...meta.tracks.map((t) => t.offsetMs + t.durationMs));
    check("cursor track recorded", samples.length > 0 && samples.length === cursorSamples,
      `${samples.length} samples written (a still cursor collapses to a few)`);
    check("cursor header names the displays", (header.screens?.length ?? 0) > 0,
      `${header.screens?.length ?? 0} display(s)`);
    check("cursor times run forwards inside the take",
      times.every((t, i) => t >= 0 && t <= recorded + 150 && (i === 0 || t >= (times[i - 1] ?? 0))),
      `${times[0]}ms … ${times[times.length - 1]}ms of ${recorded}ms`);
    // The decisive one: with the pause left in, the last sample would land
    // ~pausedFor ms after the end of the recorded content.
    const last = times[times.length - 1] ?? 0;
    check("paused time is cut out of the cursor track", Math.abs(last - recorded) < 250,
      `last sample ${last}ms vs ${recorded}ms recorded, ${Math.round(pausedFor)}ms paused`);
    log(`cursor sampling began ${times[0]}ms into the take`, "dim");
  }

  const listed = await listSessions();
  check("session appears in the library", listed.some((s) => s.id === meta.id));

  // ?keep leaves the take on disk so the Library UI has something real to show.
  if (keep) {
    log("\nkept — open the Library tab to see it");
  } else {
    await deleteSession(meta.id);
    // The server holds the cursor track for this take; the take itself never
    // reached the server, so this is the only trace to tidy.
    if (cursor) await deleteServerSession(meta.id);
    const after = await listSessions();
    check("delete removes it", !after.some((s) => s.id === meta.id));
  }

  /* --- takes whose tab died are found, recovered, or discarded -------- */
  log("\ninterrupted takes", "dim");
  const crashed = await RecordingSession.prepare([syntheticVideo("camera", 320, 240), syntheticAudio()], {
    name: "crashed take",
  });
  crashed.start();
  await wait(2000);
  const original = await crashed.stop();
  // What each file itself says, before any damage — the recorder's meta is a
  // wall-clock figure, and in a hidden tab a canvas draws about once a second,
  // so the last video packet can end well before it.
  const intact: Record<string, number> = {};
  for (const t of original.tracks) intact[t.kind] = await probeDurationMs(await getTrackFile(original.id, t.fileName));
  // No meta.json, and the microphone cut off mid-block. Audio, because Opus
  // writes a packet every 20 ms whatever the tab is doing, so what the cut
  // may cost is a few packets, not a throttled frame's worth of seconds.
  await removeLocalFile(original.id, "meta.json");
  await truncateLocalFile(original.id, "microphone.webm", 300);

  // A take still recording also has files and no meta.json. It must be left alone.
  const live = await RecordingSession.prepare([syntheticAudio()], { name: "live take" });
  live.start();
  await wait(400);

  const found = await findInterruptedTakes();
  check("an interrupted take is found", found.some((t) => t.sessionId === original.id && t.recoverable),
    `${found.length} interrupted`);
  check("a take still recording is not offered", !found.some((t) => t.sessionId === live.id));

  const { meta: recovered, unreadable, trimmed } = await recoverTake(original.id);
  check("recovery rebuilds every track", recovered.tracks.length === 2 && unreadable.length === 0,
    `${recovered.tracks.map((t) => `${t.kind} ${t.durationMs}ms`).join(", ")}` +
      (unreadable.length ? `; unreadable: ${unreadable.join(", ")}` : ""));
  check("a cut-off file is trimmed to its last complete block",
    trimmed.some((t) => t.name === "microphone.webm" && t.bytes > 0 && t.bytes < 20000),
    trimmed.map((t) => `${t.name} −${t.bytes}B`).join(", ") || "nothing trimmed");
  const got = (kind: string) => recovered.tracks.find((t) => t.kind === kind)?.durationMs ?? 0;
  check("an untouched track recovers at its full length",
    Math.abs(got("camera") - (intact.camera ?? 0)) < 60, `camera ${got("camera")} vs ${intact.camera}ms`);
  check("a cut-off track loses only its unfinished block",
    got("microphone") <= (intact.microphone ?? 0) && (intact.microphone ?? 0) - got("microphone") < 200,
    `microphone ${got("microphone")} vs ${intact.microphone}ms`);
  check("a recovered take is no longer offered",
    !(await findInterruptedTakes()).some((t) => t.sessionId === original.id));
  await live.abort();
  check("an aborted take leaves nothing to offer",
    !(await findInterruptedTakes()).some((t) => t.sessionId === live.id));

  const dropped = await RecordingSession.prepare([syntheticAudio()], { name: "dropped take" });
  dropped.start();
  await wait(600);
  const droppedMeta = await dropped.stop();
  await removeLocalFile(droppedMeta.id, "meta.json");
  await discardTake(droppedMeta.id);
  check("discard deletes an interrupted take", !(await listLocalSessionIds()).includes(droppedMeta.id));
  await deleteSession(original.id);

  log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`,
      failures === 0 ? "ok" : "bad");
}

run().catch((err) => {
  log(`threw: ${err instanceof Error ? err.stack : String(err)}`, "bad");
});
