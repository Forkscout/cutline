/**
 * End-to-end check of the editing path, with no permission prompts and no
 * human eye required.
 *
 * The reason this exists rather than a screenshot: an export can be the right
 * length, the right size and the right codec while showing the wrong thing.
 * The first export this project ever produced was exactly that — correct in
 * every measurable way and completely blank, because `sourceSize` read
 * `width`/`height` off a `VideoFrame`, which has neither. So the last steps
 * decode the file that was produced and read actual pixels out of it.
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { ArmedSource } from "./recorder/types";
import { RecordingSession } from "./recorder/session";
import { listLocalSessionIds } from "./recorder/storage";
import { deleteSession, listSessions as listServerSessions } from "./lib/media-store";
import { startSession } from "./lib/server";
import { syncLocalRecordings } from "./lib/sync";
import { importSession } from "./editor/media";
import {
  apply,
  emptyTrack,
  linkSize,
  newHistory,
  projectDuration,
  projectFromSession,
  redo,
  textClip,
  undo,
} from "./editor/project";
import { createEffect } from "./editor/effects";
import { clipAt, valueAt } from "./editor/keyframes";
import { parseSubtitles, toSrt } from "./editor/captions";
import { exportProject } from "./editor/export";
import type { ClipRef, MediaAsset, Project } from "./editor/types";

const out = document.getElementById("log")!;
const shots = document.getElementById("shots")!;
const log = (msg: string, cls = "") =>
  (out.innerHTML += cls ? `<span class="${cls}">${msg}</span>\n` : `${msg}\n`);

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`, pass ? "ok" : "bad");
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- fixtures */

function syntheticVideo(kind: "screen" | "camera", w: number, h: number): ArmedSource {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  // Flat, saturated and unmistakable: the pixel assertions identify each layer
  // by hue, so the two sources must never be confusable.
  const fill = kind === "screen" ? "#ff0000" : "#00ff00";
  const draw = () => {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, w, h);
  };
  draw();
  // setInterval, not requestAnimationFrame: rAF is suspended entirely while the
  // tab is hidden, which would silently turn this fixture into a black stream.
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
  osc.start();
  return {
    id: crypto.randomUUID(),
    kind: "microphone",
    label: "synthetic tone",
    stream: dest.stream,
    ended: false,
  };
}

function fakeAsset(): MediaAsset {
  return {
    id: "a",
    origin: { type: "recording", sessionId: "x", fileName: "screen.edit.webm" },
    name: "screen",
    kind: "video",
    sourceKind: "screen",
    mimeType: "video/webm",
    bytes: 1,
    durationSec: 10,
    hasVideo: true,
    hasAudio: false,
    width: 1280,
    height: 720,
    frameRate: 30,
    createdAt: 0,
    binId: null,
    tags: [],
    rating: 0,
    colorLabel: null,
    favorite: false,
  };
}

/* ------------------------------------------------------ pixel inspection */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function sample(ctx: CanvasRenderingContext2D, x: number, y: number): Rgb {
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0 };
}

const describe = (c: Rgb) => `rgb(${c.r},${c.g},${c.b})`;
/** Lossy codecs shift colours; identify a layer by which channel dominates. */
const isRed = (c: Rgb) => c.r > 110 && c.r > c.g + 50 && c.r > c.b + 50;
const isGreen = (c: Rgb) => c.g > 110 && c.g > c.r + 50 && c.g > c.b + 50;
const isDark = (c: Rgb) => c.r < 90 && c.g < 90 && c.b < 90;
const isBright = (c: Rgb) => c.r > 180 && c.g > 180 && c.b > 180;

/**
 * Text cannot be probed with a single pixel. A glyph is mostly empty space —
 * sampling the exact centre of "TITLE" lands between the strokes of the middle
 * letter as often as not — so the assertion scans a band and asks whether any
 * near-white pixel appears in it.
 */
function brightPixelsInBand(
  ctx: CanvasRenderingContext2D,
  centreY: number,
  bandHeight: number,
): number {
  const w = ctx.canvas.width;
  const top = Math.max(0, Math.round(centreY - bandHeight / 2));
  const height = Math.min(ctx.canvas.height - top, Math.round(bandHeight));
  const data = ctx.getImageData(0, top, w, height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (isBright({ r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0 })) count += 1;
  }
  return count;
}

async function frameCanvas(blob: Blob, at: number): Promise<CanvasRenderingContext2D | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const frame = await new VideoSampleSink(track).getSample(at);
    if (!frame) return null;
    const canvas = document.createElement("canvas");
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    frame.draw(ctx, 0, 0);
    frame.close();
    shots.appendChild(canvas);
    return ctx;
  } finally {
    input.dispose();
  }
}

/* ------------------------------------------------------------------ run */

async function run() {
  await startSession();
  /* --- pure logic, no I/O ------------------------------------------ */
  log("editing model", "dim");

  const fakeSession = {
    id: "x",
    name: "unit",
    createdAt: 0,
    durationMs: 10000,
    tracks: [
      {
        id: "a",
        kind: "screen" as const,
        label: "s",
        mimeType: "",
        fileName: "screen.webm",
        bytes: 1,
        offsetMs: 0,
        durationMs: 10000,
        pauses: [],
      },
    ],
  };

  let history = newHistory(projectFromSession(fakeSession, [fakeAsset()]));
  const track0 = history.present.tracks[0]!;
  const ref: ClipRef = { trackId: track0.id, clipId: track0.clips[0]!.id };

  history = apply(history, { type: "splitClip", ref, time: 4 });
  const afterSplit = history.present.tracks[0]!.clips;
  check("split makes two clips", afterSplit.length === 2, `${afterSplit.length}`);
  check(
    "split halves keep source continuity",
    afterSplit[0]?.duration === 4 && afterSplit[1]?.start === 4 && afterSplit[1]?.inPoint === 4,
    `first ${afterSplit[0]?.duration}s, second starts ${afterSplit[1]?.start}s at in ${afterSplit[1]?.inPoint}s`,
  );

  const secondRef: ClipRef = { trackId: track0.id, clipId: afterSplit[1]!.id };
  history = apply(history, { type: "trimClip", ref: secondRef, edge: "in", time: 5 });
  const trimmed = history.present.tracks[0]!.clips[1]!;
  check(
    "trimming the head moves start and source together",
    trimmed.start === 5 && trimmed.inPoint === 5 && Math.abs(trimmed.duration - 5) < 1e-9,
    `start ${trimmed.start}, in ${trimmed.inPoint}, dur ${trimmed.duration}`,
  );

  history = apply(history, { type: "rippleDelete", ref });
  check(
    "ripple delete closes the gap",
    history.present.tracks[0]!.clips[0]!.start === 1,
    `${history.present.tracks[0]!.clips[0]!.start}`,
  );

  const beforeUndo = history.present;
  history = undo(history);
  check("undo steps back", history.present !== beforeUndo);
  history = redo(history);
  check("redo returns", history.present === beforeUndo);

  // Keyframes
  const kfClip = { ...history.present.tracks[0]!.clips[0]! };
  kfClip.keyframes = [
    { id: "k1", property: "transform.opacity", time: 0, value: 0, easing: "linear" },
    { id: "k2", property: "transform.opacity", time: 2, value: 1, easing: "linear" },
  ];
  check("keyframe interpolates at the midpoint",
    Math.abs((valueAt(kfClip, "transform.opacity", 1) ?? -1) - 0.5) < 1e-6,
    `${valueAt(kfClip, "transform.opacity", 1)}`);
  check("keyframes are applied to the clip",
    Math.abs(clipAt(kfClip, 2).transform.opacity - 1) < 1e-6,
    `${clipAt(kfClip, 2).transform.opacity}`);
  check("keyframes hold before the first and after the last",
    valueAt(kfClip, "transform.opacity", -5) === 0 && valueAt(kfClip, "transform.opacity", 99) === 1);

  /* --- linked clips: the lip-sync guarantee ------------------------ */
  log("\nlinked clips", "dim");

  const takeSession = {
    id: "t",
    name: "take",
    createdAt: 0,
    durationMs: 10000,
    tracks: [
      { id: "v", kind: "screen" as const, label: "screen", mimeType: "", fileName: "screen.webm", bytes: 1, offsetMs: 0, durationMs: 10000, pauses: [] },
      { id: "c", kind: "camera" as const, label: "camera", mimeType: "", fileName: "camera.webm", bytes: 1, offsetMs: 0, durationMs: 10000, pauses: [] },
      { id: "a", kind: "microphone" as const, label: "mic", mimeType: "", fileName: "microphone.webm", bytes: 1, offsetMs: 0, durationMs: 10000, pauses: [] },
    ],
  };
  const takeAssets: MediaAsset[] = [
    { ...fakeAsset(), id: "v", sourceKind: "screen", origin: { type: "recording", sessionId: "t", fileName: "screen.edit.webm" } },
    { ...fakeAsset(), id: "c", sourceKind: "camera", origin: { type: "recording", sessionId: "t", fileName: "camera.edit.webm" } },
    { ...fakeAsset(), id: "a", sourceKind: "microphone", hasVideo: false, hasAudio: true, kind: "audio", origin: { type: "recording", sessionId: "t", fileName: "microphone.edit.webm" } },
  ];

  let take = newHistory(projectFromSession(takeSession, takeAssets));
  const camTrack = take.present.tracks.find((t) => t.name === "Camera")!;
  const micTrack = take.present.tracks.find((t) => t.name === "Microphone")!;
  const camRef: ClipRef = { trackId: camTrack.id, clipId: camTrack.clips[0]!.id };

  check("a take imports linked", linkSize(take.present, camTrack.clips[0]!) === 3,
    `${linkSize(take.present, camTrack.clips[0]!)} clips in the group`);

  // The failure this exists to prevent: splitting the picture and leaving the
  // voice whole, so every later edit slides the lips off the words.
  take = apply(take, { type: "splitClip", ref: camRef, time: 4 });
  const counts = take.present.tracks.map((t) => t.clips.length);
  check("splitting one clip splits the whole take", counts.every((n) => n === 2), counts.join("/"));

  const micClips = take.present.tracks.find((t) => t.id === micTrack.id)!.clips;
  check("the audio was cut at the same instant",
    Math.abs((micClips[1]?.start ?? 0) - 4) < 1e-9 && Math.abs((micClips[1]?.inPoint ?? 0) - 4) < 1e-9,
    `starts ${micClips[1]?.start}s at in ${micClips[1]?.inPoint}s`);

  const heads = take.present.tracks.map((t) => t.clips[0]!.linkId);
  const tails = take.present.tracks.map((t) => t.clips[1]!.linkId);
  check("halves stay linked as two separate groups",
    new Set(heads).size === 1 && new Set(tails).size === 1 && heads[0] !== tails[0]);

  // Moving the second half must not drag the first half with it.
  const tailCam = take.present.tracks.find((t) => t.id === camTrack.id)!.clips[1]!;
  take = apply(take, { type: "moveClip", ref: { trackId: camTrack.id, clipId: tailCam.id }, start: 6 });
  const after = take.present.tracks.map((t) => t.clips.map((c) => c.start));
  check("moving a linked clip moves its partners by the same delta",
    after.every((starts) => Math.abs((starts[1] ?? 0) - 6) < 1e-9),
    after.map((s) => s[1]?.toFixed(2)).join("/"));
  check("the other group stayed where it was",
    after.every((starts) => starts[0] === 0));

  // Detaching is the deliberate escape hatch.
  const camHead: ClipRef = { trackId: camTrack.id, clipId: take.present.tracks.find((t) => t.id === camTrack.id)!.clips[0]!.id };
  take = apply(take, { type: "detachAudio", ref: camHead });
  const micHead = take.present.tracks.find((t) => t.id === micTrack.id)!.clips[0]!;
  check("detach audio frees the sound only", micHead.linkId === null);
  check("the pictures stay linked to each other",
    linkSize(take.present, take.present.tracks.find((t) => t.id === camTrack.id)!.clips[0]!) === 2);

  take = apply(take, { type: "splitClip", ref: camHead, time: 2 });
  const micAfterDetach = take.present.tracks.find((t) => t.id === micTrack.id)!.clips.length;
  check("a detached audio clip is no longer cut with the video", micAfterDetach === 2,
    `${micAfterDetach} audio clips`);

  // Subtitles round-trip
  const srt = "1\n00:00:01,000 --> 00:00:03,500\nHello there\n\n2\n00:00:04,000 --> 00:00:05,000\nSecond line\n";
  const cues = parseSubtitles(srt);
  check("SRT parses", cues.length === 2 && cues[0]?.text === "Hello there", `${cues.length} cues`);
  check("SRT timings survive", cues[0]?.start === 1 && Math.abs((cues[0]?.end ?? 0) - 3.5) < 1e-9);
  check("SRT round-trips", parseSubtitles(toSrt(cues)).length === 2);
  check("WebVTT parses too",
    parseSubtitles("WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nVtt line").length === 1);

  /* --- record a real take ------------------------------------------ */
  log("\nrecording fixture", "dim");
  const sources = [
    syntheticVideo("screen", 1280, 720),
    syntheticVideo("camera", 480, 480),
    syntheticAudio(),
  ];
  const session = await RecordingSession.prepare(sources, { name: "editor check" });
  session.start();
  await wait(3000);
  const meta = await session.stop();
  check("recorded three tracks", meta.tracks.length === 3);

  const synced = await syncLocalRecordings();
  check(
    "take uploaded to the server",
    (await listServerSessions()).some((s) => s.id === meta.id),
    `${synced.files} files, ${(synced.bytes / 1024).toFixed(0)} KB`,
  );
  check("local copy removed only after upload", !(await listLocalSessionIds()).includes(meta.id));

  /* --- import and lay out ------------------------------------------ */
  log("\nimporting (remux, probe, thumbnail, waveform)", "dim");
  const assets = await importSession(meta);
  check("every track imported", assets.length === 3, assets.map((a) => a.sourceKind).join(", "));
  check(
    "remuxed files report a finite duration",
    assets.every((a) => a.durationSec > 0.5 && Number.isFinite(a.durationSec)),
    assets.map((a) => `${a.sourceKind} ${a.durationSec.toFixed(2)}s`).join(", "),
  );
  check("video assets get a thumbnail",
    assets.filter((a) => a.hasVideo).every((a) => Boolean(a.thumbnail)));
  check("audio assets get a waveform",
    assets.filter((a) => a.hasAudio).every((a) => (a.peaks?.length ?? 0) > 0),
    `${assets.find((a) => a.hasAudio)?.peaks?.length ?? 0} peak values`);

  const base = projectFromSession(meta, assets);
  check("project has three tracks", base.tracks.length === 3);
  check(
    "screen is the base layer and camera sits on top",
    base.tracks[0]?.name === "Screen" && base.tracks[1]?.name === "Camera",
    base.tracks.map((t) => t.name).join(" / "),
  );
  const pip = base.tracks[1]?.clips[0]?.transform;
  check("camera is auto-placed as a circular PiP",
    pip?.shape === "circle" && pip.scale < 0.5, `${pip?.shape} at ${pip?.scale}`);

  const duration = projectDuration(base);
  check("timeline length matches the take",
    Math.abs(duration - meta.durationMs / 1000) < 0.8,
    `${duration.toFixed(2)}s vs ${(meta.durationMs / 1000).toFixed(2)}s`);

  /* --- add a text layer and captions -------------------------------- */
  const titleTrack = emptyTrack("video", "Title");
  const title = textClip(0, duration);
  title.text!.content = "TITLE";
  title.text!.color = "#ffffff";
  title.text!.fontSize = 120;
  title.textAnimation = "none";
  title.transform.y = 0.18;
  titleTrack.clips = [title];

  const project: Project = {
    ...base,
    tracks: [...base.tracks, titleTrack],
    captions: [{ id: "c1", start: 0, end: duration, text: "CAPTION" }],
  };

  /* --- export ------------------------------------------------------ */
  log("\nexporting", "dim");
  const startedAt = performance.now();
  const blob = await exportProject(project, {
    container: "mp4",
    height: 720,
    frameRate: 30,
    quality: "high",
    bitrateMbps: null,
    useInOut: false,
  });
  const elapsed = (performance.now() - startedAt) / 1000;
  log(`${(blob.size / 1024).toFixed(0)} KB in ${elapsed.toFixed(1)}s (${(duration / elapsed).toFixed(1)}x realtime)`);
  check("export produced a file", blob.size > 4096, `${blob.size} bytes`);

  /* --- decode it back ---------------------------------------------- */
  log("\ninspecting the exported file", "dim");
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  const exportedDuration = await input.computeDuration();
  check("exported file has a video track", Boolean(videoTrack));
  check("exported file has an audio track", Boolean(audioTrack), audioTrack?.codec ?? "none");
  check("exported dimensions are what was asked for",
    videoTrack?.displayHeight === 720 && videoTrack?.displayWidth === 1280,
    `${videoTrack?.displayWidth}x${videoTrack?.displayHeight}`);
  check("exported duration matches the timeline",
    Math.abs(exportedDuration - duration) < 0.6,
    `${exportedDuration.toFixed(2)}s vs ${duration.toFixed(2)}s`);
  input.dispose();

  const ctx = await frameCanvas(blob, duration / 2);
  check("a frame decodes out of the export", Boolean(ctx));
  if (ctx) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const corner = sample(ctx, 4, 4);
    const centre = sample(ctx, w / 2, h / 2);
    // Where projectFromSession puts the camera: x 0.84, y 0.80.
    const pipPoint = sample(ctx, w * 0.84, h * 0.8);
    const titleBright = brightPixelsInBand(ctx, h * 0.18, h * 0.09);
    const captionBright = brightPixelsInBand(ctx, h * 0.86, h * 0.05);

    check("background shows through the padding", isDark(corner), describe(corner));
    check("screen layer fills the middle", isRed(centre), describe(centre));
    check("camera PiP is composited on top", isGreen(pipPoint), describe(pipPoint));
    check("text layer is drawn", titleBright > 200, `${titleBright} bright pixels in the title band`);
    check("captions are burned in", captionBright > 100, `${captionBright} bright pixels in the caption band`);
  }

  /* --- effects and grading actually change the picture -------------- */
  log("\neffects and grading", "dim");
  const inverted: Project = structuredClone(project);
  inverted.tracks[0]!.clips[0]!.effects = [createEffect("invert")];
  inverted.tracks = inverted.tracks.filter((t) => t.name !== "Title");
  inverted.captions = [];
  const invertedBlob = await exportProject(inverted, {
    container: "mp4", height: 360, frameRate: 12, quality: "low", bitrateMbps: null, useInOut: false,
  });
  const invertedCtx = await frameCanvas(invertedBlob, duration / 2);
  if (invertedCtx) {
    // Red inverted is cyan: the red channel should collapse and the other two rise.
    const centre = sample(invertedCtx, invertedCtx.canvas.width / 2, invertedCtx.canvas.height / 2);
    check("invert effect reaches the export", centre.r < 90 && centre.g > 110 && centre.b > 110,
      describe(centre));
  }

  const graded: Project = structuredClone(inverted);
  graded.tracks[0]!.clips[0]!.effects = [];
  graded.tracks[0]!.clips[0]!.color.saturation = -100;
  const gradedBlob = await exportProject(graded, {
    container: "mp4", height: 360, frameRate: 12, quality: "low", bitrateMbps: null, useInOut: false,
  });
  const gradedCtx = await frameCanvas(gradedBlob, duration / 2);
  if (gradedCtx) {
    const centre = sample(gradedCtx, gradedCtx.canvas.width / 2, gradedCtx.canvas.height / 2);
    // Fully desaturated red is a mid grey; all three channels should converge.
    const spread = Math.max(centre.r, centre.g, centre.b) - Math.min(centre.r, centre.g, centre.b);
    check("colour grade reaches the export", spread < 45, `${describe(centre)}, spread ${spread}`);
  }

  /* --- transitions reach the export --------------------------------- */
  // Every layer used to assign its own opacity over the transition's alpha, so
  // a dissolve changed nothing — in the preview and in the file — while the
  // project said it was there. Found by an agent looking at its own frames.
  log("\ntransitions", "dim");
  const plain: Project = structuredClone(inverted);
  plain.tracks[0]!.clips[0]!.effects = [];
  const dissolving: Project = structuredClone(plain);
  const screenClip = dissolving.tracks[0]!.clips[0]!;
  screenClip.transitionIn = { type: "dissolve", duration: screenClip.duration, easing: "linear" };
  const quick = { container: "mp4", height: 360, frameRate: 12, quality: "low", bitrateMbps: null, useInOut: false } as const;
  const midpoint = screenClip.start + screenClip.duration / 2;
  const plainCtx = await frameCanvas(await exportProject(plain, quick), midpoint);
  const dissolveCtx = await frameCanvas(await exportProject(dissolving, quick), midpoint);
  if (plainCtx && dissolveCtx) {
    const cx = plainCtx.canvas.width / 2;
    const cy = plainCtx.canvas.height / 2;
    const full = sample(plainCtx, cx, cy);
    const half = sample(dissolveCtx, cx, cy);
    const ground = sample(plainCtx, 4, 4);
    check(
      "a dissolve is half-way at its midpoint",
      half.r < full.r - 40 && half.r > ground.r + 40,
      `${describe(half)}, between ${describe(ground)} and ${describe(full)}`,
    );
  }

  await deleteSession(meta.id);
  log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`,
      failures === 0 ? "ok" : "bad");
}

run().catch((err) => log(`threw: ${err instanceof Error ? err.stack : String(err)}`, "bad"));
