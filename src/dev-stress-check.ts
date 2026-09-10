/**
 * What a long recording actually costs.
 *
 * Everything else in this project is verified against fixtures a few seconds
 * long, which proves correctness and says nothing about the case that will
 * actually break: a two-hour screen capture at native resolution, several
 * gigabytes on disk, held by a `<video>` element through a blob URL.
 *
 * This cannot run for two hours, so it runs for a minute at a high bitrate and
 * measures the things that scale linearly — throughput, heap growth, headroom —
 * then projects them. The one thing it tests outright rather than projects is
 * the part most likely to be quietly broken: seeking to the far end.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { ArmedSource } from "./recorder/types";
import { RecordingSession } from "./recorder/session";
import { deleteSession, estimateUsage } from "./recorder/storage";
import { importSession } from "./editor/media";
import { assetFile } from "./editor/media";

const out = document.getElementById("log")!;
const log = (msg: string, cls = "") =>
  (out.innerHTML += cls ? `<span class="${cls}">${msg}</span>\n` : `${msg}\n`);

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`, pass ? "ok" : "bad");
}

/** Long enough for throughput and heap trends to be real, short enough to run. */
const RECORD_SECONDS = 60;
/** Above the proxy threshold, so the proxy path is exercised too. */
const WIDTH = 2560;
const HEIGHT = 1440;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const gb = (bytes: number) => `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;

interface Heap {
  used: number;
  limit: number;
}
function heap(): Heap | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}

function syntheticScreen(): ArmedSource {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  // Noise, not a flat fill: a flat frame compresses to nearly nothing and would
  // make the throughput figure a lie.
  const draw = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 3) % 360} 60% 45%)`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    for (let i = 0; i < 400; i += 1) {
      ctx.fillRect(Math.random() * WIDTH, Math.random() * HEIGHT, 40, 40);
    }
    ctx.fillStyle = "#fff";
    ctx.font = "120px monospace";
    ctx.fillText(String(frame), 60, HEIGHT / 2);
  };
  draw();
  setInterval(draw, 1000 / 30);
  return {
    id: crypto.randomUUID(),
    kind: "screen",
    label: "synthetic 1440p",
    stream: canvas.captureStream(30),
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

async function run() {
  /**
   * A hidden tab makes every number here a lie.
   *
   * Chrome clamps `setInterval` to one second and suspends
   * `requestAnimationFrame` when the tab is not visible, so the canvas feeding
   * the recorder draws at about 1 fps. Throughput, file size and heap growth
   * all come out an order of magnitude low, and they come out looking like
   * results. Refuse rather than mislead.
   */
  if (document.hidden) {
    log("This tab is in the background.", "bad");
    log(
      "Timers are throttled and requestAnimationFrame is suspended there, so the\n" +
        "capture would run at roughly 1 fps and every measurement below would be\n" +
        "wrong by an order of magnitude — while still looking like a result.\n\n" +
        "Bring this tab to the front and reload.",
      "dim",
    );
    // Pick it up the moment the tab becomes visible, so the fix is just
    // switching to it.
    document.addEventListener(
      "visibilitychange",
      () => {
        if (!document.hidden) location.reload();
      },
      { once: true },
    );
    return;
  }

  const before = await estimateUsage();
  const heapStart = heap();
  log(`storage: ${mb(before.usage)} used of ${gb(before.quota)}`, "dim");
  if (heapStart) log(`heap at start: ${mb(heapStart.used)} of ${gb(heapStart.limit)}`, "dim");

  log(`\nrecording ${WIDTH}×${HEIGHT} for ${RECORD_SECONDS}s`, "dim");
  const sources = [syntheticScreen(), syntheticAudio()];
  const session = await RecordingSession.prepare(sources, { name: "stress check" });

  const heapPeak = { used: heapStart?.used ?? 0 };
  const sampler = window.setInterval(() => {
    const h = heap();
    if (h && h.used > heapPeak.used) heapPeak.used = h.used;
  }, 1000);

  const started = performance.now();
  session.start();
  await wait(RECORD_SECONDS * 1000);
  const meta = await session.stop();
  window.clearInterval(sampler);
  const elapsed = (performance.now() - started) / 1000;

  const bytes = meta.tracks.reduce((n, t) => n + t.bytes, 0);
  const perSecond = bytes / elapsed;
  log(`\nwrote ${mb(bytes)} in ${elapsed.toFixed(1)}s — ${mb(perSecond)}/s`);
  log(`one hour at this rate would be ${gb(perSecond * 3600)}`, "dim");

  check("the take recorded", meta.tracks.length === 2 && bytes > 1_000_000, mb(bytes));
  check(
    "duration is what was asked for",
    Math.abs(meta.durationMs / 1000 - RECORD_SECONDS) < 3,
    `${(meta.durationMs / 1000).toFixed(1)}s`,
  );

  // The point of streaming to OPFS is that the file never lives in memory. If
  // the heap grew by anything like the file size, it is being buffered and a
  // long take will end in a crash.
  if (heapStart) {
    const growth = heapPeak.used - heapStart.used;
    check(
      "memory did not track the file size",
      growth < bytes * 0.5,
      `heap grew ${mb(growth)} while writing ${mb(bytes)}`,
    );
  } else {
    log("(heap not measurable in this browser — run in Chrome for that check)", "dim");
  }

  const after = await estimateUsage();
  const headroom = after.quota - after.usage;
  log(`\nheadroom now ${gb(headroom)} — about ${(headroom / perSecond / 3600).toFixed(1)} hours at this rate`, "dim");
  check("quota has room for a long take", headroom > perSecond * 3600, gb(headroom));

  /* --- import, including the proxy transcode ------------------------ */
  log(`\nimporting (remux, probe, proxy)`, "dim");
  const importStart = performance.now();
  const assets = await importSession(meta, (p) => {
    if (p.stage === "proxy" && p.fraction !== undefined && Math.round(p.fraction * 100) % 25 === 0) {
      log(`  proxy ${Math.round(p.fraction * 100)}%`, "dim");
    }
  });
  const importSeconds = (performance.now() - importStart) / 1000;
  log(`import took ${importSeconds.toFixed(1)}s (${(importSeconds / (meta.durationMs / 1000)).toFixed(2)}× realtime)`);

  const video = assets.find((a) => a.hasVideo);
  check("a proxy was generated above the threshold", Boolean(video?.proxyName), video?.proxyName ?? "none");

  if (video?.proxyName) {
    const original = await assetFile(video, false);
    const proxy = await assetFile(video, true);
    check(
      "the proxy is materially smaller",
      proxy.size < original.size * 0.6,
      `${mb(proxy.size)} vs ${mb(original.size)}`,
    );
  }

  /* --- the thing most likely to be quietly broken ------------------- */
  log(`\nseeking`, "dim");
  if (video) {
    const file = await assetFile(video, false);
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      const sink = track ? new VideoSampleSink(track) : null;
      const duration = video.durationSec;

      for (const [label, at] of [
        ["start", 0.5],
        ["middle", duration / 2],
        ["far end", Math.max(0, duration - 1)],
      ] as const) {
        const t0 = performance.now();
        const sample = await sink?.getSample(at);
        const ms = performance.now() - t0;
        check(
          `a frame decodes at the ${label}`,
          Boolean(sample),
          `${at.toFixed(1)}s in ${ms.toFixed(0)}ms`,
        );
        sample?.close();
      }
    } finally {
      input.dispose();
    }

    // A `<video>` is what the preview actually uses, and it is the half that
    // MediaRecorder's index-less output used to break.
    const url = URL.createObjectURL(await assetFile(video, true));
    const el = document.createElement("video");
    el.src = url;
    el.muted = true;
    const seekable = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      el.addEventListener("loadedmetadata", () => {
        el.currentTime = Math.max(0, video.durationSec - 1);
      });
      el.addEventListener("seeked", () => {
        clearTimeout(timer);
        resolve(Number.isFinite(el.duration) && el.currentTime > video.durationSec - 2);
      });
      el.addEventListener("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    check("a <video> element can seek to the far end", seekable, `duration ${el.duration}`);
    URL.revokeObjectURL(url);
  }

  await deleteSession(meta.id);
  log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`, failures === 0 ? "ok" : "bad");
}

run().catch((err) => log(`threw: ${err instanceof Error ? err.stack : String(err)}`, "bad"));
