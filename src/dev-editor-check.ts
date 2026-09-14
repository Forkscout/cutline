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
import { importFiles, importSession } from "./editor/media";
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
import { captionsForAsset, captionsFromWords, dropEchoes, dropLoops, wordsFromVerboseJson, wordsOnTimeline } from "./editor/transcript";
import { transcriptHoles } from "./editor/inspect";
import { createProject as newProject, mediaClip as newMediaClip, reduce, replaceValue, rowHeight, shapeClip } from "./editor/project";
import { needsConfirming, numbersIn, scanNumbers } from "./editor/facts";
import { lintScene } from "./editor/lint";
import { brandOverrides, contrast, mergeTheme, paletteOf, themeById } from "./editor/themes";
import { AnchorError, findPhrase, resolveAnchor } from "./editor/storyboard";
import { afterCut, cutRange, lockedTracksIn, rangeOfWords, snapToWords } from "./editor/cut";
import { exportProject } from "./editor/export";
import { clipBox, drawFrame, textLineBoxes, type ClipBox } from "./editor/compositor";
import { counterText, formatCount, parseFigure, settledText } from "./editor/counter";
import { addCoin, addStack, addStat, addTable, addTree, measureOnCanvas, type MacroContext } from "./editor/agent-macros";
import { coverScale, kenBurnsKeys, placeImage } from "./editor/image";
import type { Action } from "./editor/project";
import type { Clip, ClipRef, Easing, MediaAsset, Project } from "./editor/types";

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

  /* --- keyframes across a split and a head trim ---------------------- */
  log("\nkeyframes across cuts", "dim");
  {
    const moving = (keys: [number, number, Easing][]) => {
      const c = shapeClip(10, 20);
      c.keyframes = keys.map(([time, value, easing], i) => ({ id: `m${i}`, property: "transform.x", time, value, easing }));
      return c;
    };
    /** The value on the timeline, as the compositor would draw it. */
    const onTimeline = (c: Clip, t: number) => valueAt(c, "transform.x", t - c.start) ?? c.transform.x;
    /** The largest difference at any time the pieces cover, sampled every 50 ms. */
    const worst = (before: Clip, pieces: Clip[], from: number, to: number) => {
      let most = 0;
      for (let t = from; t <= to; t += 0.05) {
        const piece = pieces.find((c) => t >= c.start && t < c.start + c.duration);
        if (piece) most = Math.max(most, Math.abs(onTimeline(before, t) - onTimeline(piece, t)));
      }
      return most;
    };
    const edit = (clip: Clip, action: (ref: ClipRef) => Parameters<typeof reduce>[1]) => {
      let p = newProject("keyframes across cuts");
      const track = p.tracks.find((t) => t.kind === "video")!;
      track.clips = [structuredClone(clip)];
      p = reduce(p, action({ trackId: track.id, clipId: clip.id }));
      return p.tracks.find((t) => t.id === track.id)!.clips;
    };

    // The speaker moves into a side panel by 11 s and is held there to the end.
    const held = moving([[0, 0.5, "ease"], [1, 0.875, "linear"]]);
    const heldSplit = edit(held, (ref) => ({ type: "splitClip", ref, time: 20 }));
    check("a layout held past its last keyframe survives a split",
      heldSplit.length === 2 && worst(held, heldSplit, 10, 29.99) < 1e-9, `worst ${worst(held, heldSplit, 10, 29.99)}`);

    // A split in the middle of an eased move.
    const mid = moving([[2, 0.5, "ease"], [4, 0.875, "ease"], [8, 0.2, "easeOut"]]);
    const midSplit = edit(mid, (ref) => ({ type: "splitClip", ref, time: 13.3 }));
    check("a split mid-move keeps the curve exactly", midSplit.length === 2 && worst(mid, midSplit, 10, 29.99) < 1e-9,
      `worst ${worst(mid, midSplit, 10, 29.99)}`);

    // A head trim, shorter and then longer, leaves the animation where it was on the timeline.
    const shorter = edit(mid, (ref) => ({ type: "trimClip", ref, edge: "in", time: 13.3 }));
    check("trimming the head leaves the animation where it was on the timeline",
      shorter[0]!.start === 13.3 && worst(mid, shorter, 13.3, 29.99) < 1e-9, `worst ${worst(mid, shorter, 13.3, 29.99)}`);
    const longer = edit(shorter[0]!, (ref) => ({ type: "trimClip", ref, edge: "in", time: 11 }));
    check("and extending it back again does too", worst(mid, longer, 11, 29.99) < 1e-9, `worst ${worst(mid, longer, 11, 29.99)}`);
  }

  /* --- cutting a range of time ------------------------------------------ */
  log("\ncutting a range", "dim");
  {
    const said = [["one", 0, 0.4], ["two", 0.6, 1.0], ["three", 1.2, 1.6], ["four", 2.0, 2.4], ["five", 2.6, 3.0], ["six", 3.2, 3.6], ["seven", 3.8, 4.2]] as const;
    const take: MediaAsset = {
      id: "cut-take", origin: { type: "file" }, name: "take", kind: "video", mimeType: "video/webm",
      bytes: 1, durationSec: 5, hasVideo: true, hasAudio: true, width: 1920, height: 1080, frameRate: 30,
      createdAt: 0, binId: null, tags: [], rating: 0, colorLabel: null, favorite: false,
      transcript: {
        version: 1, provider: "check", model: "none", language: "en", durationSec: 5, timing: "word", createdAt: 0,
        words: said.map(([text, start, end]) => ({ text, start, end })),
      },
    };
    const p = newProject("cut check");
    p.assets = [take];
    const picture = newMediaClip(take, 10);
    // Into a side panel over 0.8 s and held, and a slower scale later: what a cut must not disturb.
    picture.keyframes = [
      { id: "kx0", property: "transform.x", time: 0, value: 0.5, easing: "ease" },
      { id: "kx1", property: "transform.x", time: 0.8, value: 0.875, easing: "linear" },
      { id: "ks0", property: "transform.scale", time: 1.5, value: 1, easing: "ease" },
      { id: "ks1", property: "transform.scale", time: 3.5, value: 0.6, easing: "ease" },
    ];
    p.tracks.find((t) => t.kind === "video")!.clips = [picture];
    const graphic = (start: number, duration: number, content: string) => {
      const c = textClip(start, duration);
      c.text!.content = content;
      return c;
    };
    const titles = emptyTrack("video", "Titles");
    titles.clips = [graphic(10.2, 0.6, "before"), graphic(11.0, 3.0, "across"), graphic(14.0, 1.0, "after")];
    const extras = emptyTrack("video", "Extras");
    extras.clips = [graphic(11.5, 0.5, "inside"), graphic(16.0, 1.0, "later")];
    p.tracks = [...p.tracks, titles, extras];
    p.markers = [
      { id: "m1", time: 13.5, duration: 0, name: "after", note: "", color: "#ffffff" },
      { id: "m2", time: 11.8, duration: 0, name: "inside", note: "", color: "#ffffff" },
    ];
    p.captions = [
      { id: "c1", start: 10.0, end: 11.1, text: "one two" },
      { id: "c2", start: 11.2, end: 12.4, text: "three four" },
      { id: "c3", start: 12.6, end: 14.2, text: "five six seven" },
    ];
    p.inPoint = 11.5;
    p.outPoint = 14.5;

    const words = wordsOnTimeline(p);
    const { from, to } = rangeOfWords(words, 2, 3);
    check("cutting words runs from the middle of the pause before to the middle of the pause after",
      Math.abs(from - 11.1) < 1e-9 && Math.abs(to - 12.5) < 1e-9, `${from}–${to}`);
    check("a boundary inside a word moves to the nearer pause; one in a pause stays",
      Math.abs(snapToWords(words, 11.3) - 11.1) < 1e-9 && Math.abs(snapToWords(words, 11.5) - 11.8) < 1e-9 && snapToWords(words, 11.9) === 11.9,
      `${snapToWords(words, 11.3)} ${snapToWords(words, 11.5)} ${snapToWords(words, 11.9)}`);

    const cut = cutRange(p, from, to);
    const length = to - from;
    const on = (name: string) => cut.tracks.find((t) => t.name === name)!.clips;
    const texts = (list: Clip[]) => list.map((c) => `${c.text?.content}@${c.start.toFixed(2)}+${c.duration.toFixed(2)}`).join(" ");
    check("every graphic after the cut moves left by exactly the removed length",
      Math.abs(on("Titles").find((c) => c.text?.content === "after")!.start - (14 - length)) < 1e-9 &&
        Math.abs(on("Extras").find((c) => c.text?.content === "later")!.start - (16 - length)) < 1e-9,
      `${texts(on("Titles"))} | ${texts(on("Extras"))}`);
    check("a graphic inside the cut goes, and one before it stays where it was",
      !on("Extras").some((c) => c.text?.content === "inside") && on("Titles").some((c) => c.text?.content === "before" && c.start === 10.2));
    const across = on("Titles").filter((c) => c.text?.content === "across");
    check("a graphic across the cut is split at it, and its tail does not enter again",
      across.length === 2 && Math.abs(across[0]!.start + across[0]!.duration - from) < 1e-9 && Math.abs(across[1]!.start - from) < 1e-9 &&
        across[1]!.textAnimation === "none",
      texts(across));

    // The same source frame, with the same transform, at every moment that survives.
    const pieces = cut.tracks.find((t) => t.kind === "video")!.clips;
    let worst = 0;
    let covered = 0;
    for (let k = 0; k < 100; k += 1) {
      const s = k * 0.05;
      const before = 10 + s;
      if (before > from - 1e-9 && before < to + 1e-9) continue;
      const after = afterCut(before, from, to);
      const piece = pieces.find(
        (c) => after >= c.start - 1e-9 && after < c.start + c.duration - 1e-9 && Math.abs(c.inPoint + (after - c.start) * c.speed - s) < 1e-6,
      );
      if (!piece) continue;
      covered += 1;
      for (const property of ["transform.x", "transform.scale"]) {
        worst = Math.max(worst, Math.abs((valueAt(picture, property, s) ?? 0) - (valueAt(piece, property, after - piece.start) ?? 0)));
      }
    }
    check("the picture shows the same source frame with the same transform at every surviving moment",
      pieces.length === 2 && covered >= 60 && worst < 1e-9, `${pieces.length} pieces, ${covered} moments, worst ${worst}`);

    const joined = wordsOnTimeline(cut).map((w) => w.text).join(" ");
    check("the transcript reads straight across the join", joined === "one two five six seven", joined);

    check("markers, captions and the in and out points move with the cut",
      Math.abs(cut.markers.find((m) => m.id === "m1")!.time - (13.5 - length)) < 1e-9 &&
        Math.abs(cut.markers.find((m) => m.id === "m2")!.time - from) < 1e-9 &&
        !cut.captions.some((c) => c.id === "c2") &&
        Math.abs(cut.captions.find((c) => c.id === "c3")!.start - (12.6 - length)) < 1e-9 &&
        Math.abs((cut.inPoint ?? -1) - from) < 1e-9 &&
        Math.abs((cut.outPoint ?? -1) - (14.5 - length)) < 1e-9,
      `markers ${cut.markers.map((m) => m.time.toFixed(2))} · captions ${cut.captions.map((c) => `${c.text}@${c.start.toFixed(2)}`)} · in ${cut.inPoint} out ${cut.outPoint}`);

    const locked = { ...p, tracks: p.tracks.map((t) => (t.name === "Extras" ? { ...t, locked: true } : t)) };
    check("a cut that would leave a locked track behind is refused and changes nothing",
      lockedTracksIn(locked, from).length === 1 && reduce(locked, { type: "cutRange", from, to }) === locked);

    const pair = newProject("cut links");
    const v = newMediaClip(take, 0);
    const a = newMediaClip(take, 0);
    v.linkId = "take";
    a.linkId = "take";
    pair.tracks.find((t) => t.kind === "video")!.clips = [v];
    pair.tracks.find((t) => t.kind === "audio")!.clips = [a];
    const cutPair = cutRange(pair, 1, 2).tracks.flatMap((t) => t.clips);
    const heads = cutPair.filter((c) => c.start === 0);
    const tails = cutPair.filter((c) => c.start === 1);
    check("a linked take stays linked on each side of a cut, as two groups",
      heads.length === 2 && tails.length === 2 && heads.every((c) => c.linkId === "take") && tails[0]!.linkId === tails[1]!.linkId && tails[0]!.linkId !== "take");
  }

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

  /* --- transcripts become captions, through the clips ----------------- */
  log("\ntranscripts", "dim");
  {
    const said = [
      ["Hello", 0.0, 0.4], ["there.", 0.45, 0.9],
      ["This", 1.0, 1.3], ["is", 1.35, 1.6], ["Cutline.", 1.65, 2.0],
      ["After", 3.0, 3.4], ["a", 3.45, 3.8], ["pause.", 3.85, 4.3],
    ] as const;
    const voice: MediaAsset = {
      id: "voice", origin: { type: "file" }, name: "voice", kind: "audio", mimeType: "audio/webm",
      bytes: 1, durationSec: 5, hasVideo: false, hasAudio: true, width: 0, height: 0, frameRate: 30,
      createdAt: 0, binId: null, tags: [], rating: 0, colorLabel: null, favorite: false,
      transcript: {
        version: 1, provider: "check", model: "none", language: "en", durationSec: 5, timing: "word", createdAt: 0,
        words: said.map(([text, start, end]) => ({ text, start, end })),
      },
    };
    const heard = newProject("transcript check");
    const clip = newMediaClip(voice, 10);
    // Source 1.0–4.0 s, heard at timeline 10–13 s: "Hello there." is trimmed
    // off the head and "pause." mostly off the tail.
    clip.inPoint = 1;
    clip.duration = 3;
    heard.assets = [voice];
    heard.tracks.find((t) => t.kind === "audio")!.clips = [clip];

    const onTimeline = wordsOnTimeline(heard);
    check("words land on the timeline through their clip",
      onTimeline.length === 5 && Math.abs((onTimeline[0]?.start ?? 0) - 10) < 0.001,
      onTimeline.map((w) => `${w.text}@${w.start.toFixed(2)}`).join(" "));
    const cues = captionsFromWords(onTimeline);
    check("a pause and a sentence end each start a new caption",
      cues.length === 2 && cues[0]?.text === "This is Cutline." && cues[1]?.text === "After a",
      cues.map((c) => `"${c.text}"`).join(", "));
    const long = captionsFromWords(
      Array.from({ length: 40 }, (_, i) => ({ text: "caption", start: i * 0.3, end: i * 0.3 + 0.25 })),
    );
    check("no caption runs longer than a line", long.every((c) => c.text.length <= 42), `${long.length} cues`);

    // The sentence the UI check spoke. A line may run a little long to take
    // the word that ends its sentence, and breaks after a comma, not mid-clause.
    const spoken = "Welcome to Cutline. This take was recorded to test automatic captions. Every word should appear on the timeline, at the moment it is spoken."
      .split(" ")
      .map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 }));
    const lines = captionsFromWords(spoken).map((c) => c.text);
    check("a sentence's last word stays on its line, and lines break at commas",
      lines.join(" | ") ===
        "Welcome to Cutline. | This take was recorded to test automatic captions. | Every word should appear on the timeline, | at the moment it is spoken.",
      lines.map((l) => `"${l}"`).join(", "));

    // Recaptioning one voice must not take a second speaker's captions with it.
    const rebuilt = captionsForAsset(
      {
        ...heard,
        captions: [
          { id: "stale", start: 10.5, end: 11, text: "old" },
          { id: "other", start: 30, end: 32, text: "someone else" },
        ],
      },
      "voice",
      voice.transcript!,
    );
    check("recaptioning an asset replaces its cues and keeps everyone else's",
      rebuilt.added === 2 && rebuilt.cues.some((c) => c.id === "other") && !rebuilt.cues.some((c) => c.id === "stale"),
      rebuilt.cues.map((c) => `"${c.text}"`).join(", "));

    // whisper.cpp's word tokens are bytes: a Hindi character's halves arrive as
    // U+FFFD. Its segments, one word each under max_len=1, are whole.
    const hindi = wordsFromVerboseJson({
      segments: [
        { start: 0, end: 0.5, text: " नमस्ते", words: [{ word: " न", start: 0, end: 0.2 }, { word: "\uFFFD\uFFFD", start: 0.2, end: 0.5 }] },
        { start: 0.5, end: 1.1, text: " दोस्तों", words: [{ word: " द", start: 0.5, end: 0.8 }, { word: "\uFFFD", start: 0.8, end: 1.1 }] },
      ],
    });
    check("broken byte tokens fall back to whole words from the segments",
      hindi.words.map((w) => w.text).join(" ") === "नमस्ते दोस्तों" && hindi.timing === "word",
      `${hindi.words.map((w) => w.text).join(" ")} (${hindi.timing})`);

    const timed = (texts: string[]) => texts.map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.15 }));
    const looped = dropLoops(timed([
      "no", "delay,", "no", "approval", ...Array<string>(40).fill("re"), "and", "then",
      ...Array.from({ length: 12 }, () => ["one", "two"]).flat(), "end",
    ]));
    check("a phrase the model repeated in a loop is kept once",
      looped.map((w) => w.text).join(" ") === "no delay, no approval re and then one two end",
      looped.map((w) => w.text).join(" ").slice(0, 80));
    check("a phrase said twice on purpose is kept",
      dropLoops(timed(["cash,", "park,", "cash,", "park"])).length === 4);
    const echoed = dropEchoes([
      { start: 179.7, end: 180.1, text: "क्योंकि" },
      { start: 180.0, end: 180.08, text: "क्योंकि" },
      { start: 180.2, end: 180.5, text: "यह" },
      { start: 181.0, end: 181.3, text: "no" },
      { start: 181.35, end: 181.6, text: "no" },
    ]);
    check("a word heard twice where parts overlapped is kept once; one said twice is kept twice",
      echoed.length === 4 && echoed.filter((w) => w.text === "no").length === 2, echoed.map((w) => w.text).join(" "));
  }

  /* --- brief and theme ---------------------------------------------- */
  log("\nbrief and theme", "dim");
  {
    let p = newProject("brief check");
    p = reduce(p, { type: "setBrief", patch: { goal: "Explain the protocol", brand: { name: "TreeFlux" } } });
    p = reduce(p, { type: "setBrief", patch: { brand: { colors: ["#0E7C5A"] } }, decision: "Side panel: she is the draw" });
    check("a brief patch keeps what it did not name, and logs the decision",
      p.brief.goal === "Explain the protocol" && p.brief.brand.name === "TreeFlux" && p.brief.brand.colors[0] === "#0E7C5A"
        && p.brief.decisions.length === 1 && p.brief.decisions[0]!.text.startsWith("Side panel"),
      JSON.stringify({ goal: p.brief.goal, brand: p.brief.brand, decisions: p.brief.decisions.length }));

    const video = p.tracks.find((t) => t.kind === "video")!;
    const tagged = textClip(0, 3);
    tagged.role = "title";
    const card = shapeClip(0, 3);
    card.role = "card";
    const plain = textClip(0, 3);
    plain.text!.color = "#123456";
    video.clips = [tagged, card, plain];
    const light = themeById("clean-light");
    p = reduce(p, { type: "setTheme", theme: light, restyle: true });
    const [t2, c2, p2] = p.tracks.find((t) => t.kind === "video")!.clips;
    check("a theme restyles the clips a macro made, and only those",
      t2?.text?.color === light.palette.text && t2?.text?.fontFamily === light.fonts.display
        && c2?.shape?.fill === light.palette.surface && p2?.text?.color === "#123456",
      `title ${t2?.text?.color}, card ${c2?.shape?.fill}, untagged ${p2?.text?.color}`);
    check("and sets the background from its palette",
      p.background.type === "gradient" && p.background.from === light.palette.background, JSON.stringify(p.background));

    const tuned = mergeTheme(themeById("studio-dark"), { palette: { accent: "#22C55E" } });
    check("an override changes one token and keeps the rest",
      tuned.palette.accent === "#22C55E" && tuned.palette.text === themeById("studio-dark").palette.text && tuned.id === "studio-dark-custom",
      `${tuned.id} accent ${tuned.palette.accent}`);
    check("contrast is measured the WCAG way", Math.abs(contrast("#000000", "#ffffff") - 21) < 0.01 && contrast("#777", "#777") === 1);

    // A logo: a dark green mark on a transparent ground, with a little white.
    const logo: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      if (i < 240) logo.push(0, 0, 0, 0);
      else if (i < 380) logo.push(14, 90, 52, 255);
      else logo.push(255, 255, 255, 255);
    }
    const palette = paletteOf(logo);
    check("a logo's transparent ground is left out of its palette",
      palette.length === 2 && palette[0]!.share > 0.8, palette.map((p) => `${p.hex} ${p.share}`).join(", "));
    const onDark = brandOverrides(palette, themeById("studio-dark"));
    const onLight = brandOverrides(palette, themeById("clean-light"));
    check("the brand colour becomes an accent that reads on a dark background",
      onDark.contrast >= 3 && onDark.overrides.palette?.accent === onDark.accent, `${onDark.accent} at ${onDark.contrast}:1`);
    check("and on a light one", onLight.contrast >= 3, `${onLight.accent} at ${onLight.contrast}:1`);
    const grey = brandOverrides(paletteOf([128, 128, 128, 255, 200, 200, 200, 255]), themeById("studio-dark"));
    check("a neutral picture leaves the theme's accent alone", Object.keys(grey.overrides).length === 0, grey.notes.join(" "));
  }

  /* --- storyboard anchors ------------------------------------------ */
  log("\nstoryboard anchors", "dim");
  {
    const said = ["Treeflux", "एक", "referral", "protocol", "है,", "placement", "tree", "दो", "सीट", "की", "होती", "है", "दूसरी", "सीट", "भर", "गई."]
      .map((text, i) => ({ text, start: 10 + i, end: 10 + i + 0.8, clipId: "c", trackId: "t" }));
    check("a phrase is found through punctuation and case", findPhrase(said, "referral Protocol", 0)?.start === 12);
    check("a transcript's misspelling still matches", findPhrase(said, "treflux", 0)?.start === 10);
    check("a Hindi phrase matches", findPhrase(said, "दो सीट", 0)?.start === 17);
    check("the next occurrence after the previous anchor is the one used",
      resolveAnchor({ word: "सीट" }, said, 19) === 23 && resolveAnchor({ word: "सीट" }, said, 0) === 18);
    check("an offset shifts it", resolveAnchor({ word: "placement", offset: -0.3 }, said, 0) === 14.7);
    let missing = "";
    try {
      resolveAnchor({ word: "spillover" }, said, 0);
    } catch (err) {
      missing = err instanceof AnchorError ? err.message : "";
    }
    check("a phrase never said is an error with suggestions", missing.includes("not said") && missing.includes("Closest"), missing.slice(0, 90));
  }

  /* --- facts to confirm ---------------------------------------------- */
  log("\nfacts to confirm", "dim");
  {
    check("a correction replaces whole values only",
      replaceValue("Level 7 costs 7 USDT, not 17, 7,000 or 3.7", "7", "60") === "Level 60 costs 60 USDT, not 17, 7,000 or 3.7");
    check("a correction is literal", replaceValue("costs 12", "12", "$12") === "costs $12");
    check("numbers are read off text as written", numbersIn("Row 9: 512 seats, 1,26,000 USDT and 5%.").join(" ") === "9 512 1,26,000 5%");

    // Said: "Level 3 costs तीस and 21 ,600". Shown: 3, 30, 21,600 — and 60, which nobody said.
    const said = [["Level", 0, 0.4], ["3", 0.5, 0.8], ["costs", 0.9, 1.2], ["तीस", 1.3, 1.6], ["and", 2, 2.2], ["21", 2.3, 2.6], [",600", 2.6, 2.9]] as const;
    const voice: MediaAsset = {
      id: "facts-voice", origin: { type: "file" }, name: "voice", kind: "audio", mimeType: "audio/webm",
      bytes: 1, durationSec: 6, hasVideo: false, hasAudio: true, width: 0, height: 0, frameRate: 30,
      createdAt: 0, binId: null, tags: [], rating: 0, colorLabel: null, favorite: false,
      transcript: {
        version: 1, provider: "check", model: "none", language: "hi", durationSec: 6, timing: "word", createdAt: 0,
        words: said.map(([text, start, end]) => ({ text, start, end })),
      },
    };
    let p = newProject("facts check");
    p.assets = [voice];
    p.tracks.find((t) => t.kind === "audio")!.clips = [newMediaClip(voice, 0)];
    const shown = (content: string, start: number) => {
      const c = textClip(start, 2);
      c.text!.content = content;
      return c;
    };
    const cheap = shown("Level 3 · 30 USDT", 1);
    const pool = shown("Pool · 21,600 USDT", 2);
    const dear = shown("Level 3 · 60 USDT", 3);
    const titles = emptyTrack("video", "Titles");
    titles.clips = [cheap, pool, dear];
    p.tracks = [...p.tracks, titles];
    const numbers = scanNumbers(p);
    const heard = (v: string) => numbers.find((n) => n.value === v)?.heard;
    check("a number said as digits, as a Hindi word, or split at its comma is heard",
      heard("3") === true && heard("30") === true && heard("21,600") === true, numbers.map((n) => `${n.value}:${n.heard}`).join(" "));
    check("a number nobody said is the one to confirm", numbers.filter(needsConfirming).map((n) => n.value).join() === "60");

    p.storyboard = {
      version: 1, compiledAt: null,
      scenes: [{ id: "s", from: { time: 0 }, to: { time: 5 }, layout: "panel", components: [{ id: "t", type: "title", at: { word: "60 USDT" }, title: "Level 3 · 60 USDT" }] }],
    };
    p = reduce(p, { type: "correctFact", id: "f1", from: "60", to: "40" });
    const text = (id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.text?.content;
    const component = p.storyboard?.scenes[0]?.components[0];
    check("a correction reaches every clip showing it, and no other",
      text(dear.id) === "Level 3 · 40 USDT" && text(cheap.id) === "Level 3 · 30 USDT", `${text(dear.id)} / ${text(cheap.id)}`);
    check("and the storyboard, leaving anchors alone",
      component?.type === "title" && component.title === "Level 3 · 40 USDT" && "word" in component.at && component.at.word === "60 USDT");
    check("the fact is recorded as corrected, with what it replaced",
      p.facts[0]?.status === "corrected" && p.facts[0].value === "40" && p.facts[0].was === "60");
  }

  /* --- versions --------------------------------------------------------- */
  log("\nversions", "dim");
  {
    const now = newProject("versions");
    const then = { ...newProject("then"), name: "As it was" };
    const restored = reduce(now, { type: "restoreVersion", project: then, label: "v1" });
    check("a restore takes the version's content and keeps the project's id", restored.id === now.id && restored.name === "As it was");
  }

  /* --- checks ---------------------------------------------------------- */
  log("\nchecks", "dim");
  {
    const q = newProject("lint check");
    const text = (content: string, start: number, duration: number, x = 0.5, color?: string) => {
      const c = textClip(start, duration);
      c.text!.content = content;
      c.transform.x = x;
      c.transform.y = 0.5;
      if (color) c.text!.color = color;
      return c;
    };
    const first = text("First line of text", 0, 4);
    const second = text("Second line of text", 0, 4);
    const off = text("Runs off the edge", 5, 4, 0.99);
    const brief = text("Far too many words to read in so short a time", 10, 0.8);
    const fine = text("Fine", 12, 4);
    const dark = text("Dark", 17, 3, 0.5, "#101010");
    const light = text("Light", 21, 3, 0.5, "#FFFFFF");
    const a = emptyTrack("video", "A");
    a.clips = [first, off, brief, fine, dark, light];
    const b = emptyTrack("video", "B");
    b.clips = [second];
    q.tracks = [...q.tracks, a, b];
    const report = await lintScene(q, { to: 16, contrast: false });
    const about = (id: string) => report.issues.filter((i) => i.clips.some((c) => c.clipId === id)).map((i) => i.kind);
    check("text on text is an overlap", about(first.id).includes("overlap") && about(second.id).includes("overlap"));
    check("text running off the frame is caught", report.issues.some((i) => i.kind === "off-frame" && i.severity === "error" && i.clips[0]?.clipId === off.id));
    check("text too brief to read is caught", about(brief.id).includes("too-brief"));
    check("a clean title raises nothing", about(fine.id).length === 0, about(fine.id).join());
    const range = await lintScene(q, { from: 11.5, to: 16, contrast: false });
    check("a range lints only what is in it", range.checked === 1 && range.issues.length === 0);
    // Measured on the rendered frame: one of these is the colour of the ground behind it.
    const seen = await lintScene(q, { from: 16.5, to: 24 });
    const low = seen.issues.filter((i) => i.kind === "contrast").map((i) => i.clips[0]?.text);
    check("contrast is measured on the frame, and only the unreadable one fails",
      seen.contrastMeasured === 2 && low.length === 1, `${seen.contrastMeasured} measured; low: ${low.join()} · ${seen.issues.map((i) => i.detail).join(" | ")}`);
  }

  /* --- tables, stacks and motion: few tracks, and the frames show it ------- */
  // A price table made a clip per cell once took a project from 28 video tracks
  // to 44. A column is one clip now, its rows brought in by text.reveal.
  log("\ntables, stacks and motion", "dim");
  {
    const fresh = (name: string): Project => ({ ...newProject(name), width: 960, height: 540, theme: themeById("studio-dark") });
    let doc = fresh("table");
    const ctx: MacroContext = { project: () => doc, commit: (action) => { doc = reduce(doc, action); }, measure: measureOnCanvas, tag: { component: "check" } };
    const all = () => doc.tracks.flatMap((t) => t.clips);
    const videoTracks = () => doc.tracks.filter((t) => t.kind === "video").length;
    const frame = (p: Project, t: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = p.width;
      canvas.height = p.height;
      const c = canvas.getContext("2d", { willReadFrequently: true })!;
      drawFrame(c, p, t, () => null);
      return c;
    };
    const without = (p: Project, keep: (c: Clip) => boolean): Project => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter(keep) })) });
    // Pixels that differ between two frames, in a box.
    const differ = (a: CanvasRenderingContext2D, b: CanvasRenderingContext2D, x0 = 0, y0 = 0, x1 = a.canvas.width, y1 = a.canvas.height) => {
      const w = Math.max(1, Math.round(x1 - x0));
      const h = Math.max(1, Math.round(y1 - y0));
      const da = a.getImageData(Math.round(x0), Math.round(y0), w, h).data;
      const db = b.getImageData(Math.round(x0), Math.round(y0), w, h).data;
      let n = 0;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!) > 30) n += 1;
      return n;
    };
    const around = (b: ClipBox) => [b.cx + b.x - 4, b.cy + b.y - 4, b.cx + b.x + b.w + 4, b.cy + b.y + b.h + 4] as const;

    const before = videoTracks();
    addTable(ctx, {
      end: 20,
      columns: [{ header: "Level" }, { header: "Price" }, { header: "Needs" }],
      rows: Array.from({ length: 9 }, (_, i) => ({ at: 1 + i * 0.8, cells: [`Level ${i + 1}`, `₹${(i + 1) * 1000}`, { text: `${(i + 1) * 2} referrals`, at: 9 + i * 0.3 }] })),
    });
    const tableTracks = videoTracks() - before;
    check("a 9 × 3 table takes a handful of tracks, not one per cell", tableTracks <= 8, `${tableTracks} tracks for ${all().length} clips`);
    check("everything one call makes is one component", all().every((c) => c.component === "check"));
    const empty = frame(without(doc, () => false), 0);
    const price = all().find((c) => c.text?.content.startsWith("₹1000"))!;
    const priceLines = textLineBoxes(doc, price);
    const sixth = around(priceLines[5]!.box);
    check("a row is not drawn before its word, and is once it has arrived",
      differ(frame(doc, 4.9), empty, ...sixth) < 5 && differ(frame(doc, 5.6), empty, ...sixth) > 40,
      `${differ(frame(doc, 4.9), empty, ...sixth)} px before, ${differ(frame(doc, 5.6), empty, ...sixth)} after`);
    check("rows above it stay drawn", differ(frame(doc, 4.9), empty, ...around(priceLines[0]!.box)) > 40);
    const needs = all().find((c) => c.text?.content.startsWith("2 referrals"))!;
    const firstNeed = around(textLineBoxes(doc, needs)[0]!.box);
    check("a column whose cells have their own times fills in later",
      differ(frame(doc, 8.8), empty, ...firstNeed) < 5 && differ(frame(doc, 9.6), empty, ...firstNeed) > 40);
    const sixThousand = scanNumbers(doc).find((n) => n.value.replace(/\D/g, "") === "6000");
    check("the fact check times a figure from when its row arrives", Boolean(sixThousand) && Math.abs(sixThousand!.shown[0]!.start - 5.1) < 0.3,
      sixThousand ? `shown from ${sixThousand.shown[0]!.start.toFixed(2)} s` : "not found");
    const lint = await lintScene(doc, { from: 0, to: 20, contrast: false });
    const clashes = lint.issues.filter((i) => i.kind === "overlap");
    check("lint reads a column line by line: a clean table has no overlaps", clashes.length === 0, clashes.map((i) => i.detail).join(" | "));

    doc = fresh("stack");
    const stackBefore = videoTracks();
    addStack(ctx, {
      end: 12,
      items: Array.from({ length: 6 }, (_, i) => ({ at: 1 + i, title: `Level ${i + 1}`, value: `${6 ** i} seats` })),
      connectors: Array.from({ length: 5 }, () => "↓ ×6"),
    });
    const cards = all().filter((c) => c.kind === "shape");
    const titles = all().find((c) => c.text?.content.startsWith("Level 1"))!;
    const offsets = textLineBoxes(doc, titles).map((l, i) => Math.abs(l.box.cy + l.box.y + l.box.h / 2 - cards[i]!.transform.y * doc.height));
    check("a stack of six cards takes nine tracks", videoTracks() - stackBefore === 9, `${videoTracks() - stackBefore}`);
    check("each title sits in the middle of its card", offsets.length === 6 && Math.max(...offsets) < 1.5, offsets.map((o) => o.toFixed(2)).join(" "));

    doc = fresh("tree");
    addTree({ ...ctx, tag: { component: "tree" } }, {
      end: 12,
      ghost: 2,
      nodes: [
        { id: "you", label: "You", at: 1 },
        { id: "a", label: "A", parent: "you", at: 2, flash: true },
        { id: "b", label: "B", parent: "you", at: 3 },
      ],
    });
    const ghost = all().find((c) => c.shape?.kind === "path");
    check("a tree's empty seats and edges are one path clip", Boolean(ghost) && all().filter((c) => c.role === "ghost").length === 1);
    const seatsDrawn = differ(frame(doc, 6), frame(without(doc, (c) => c.role !== "ghost"), 6));
    check("and they are drawn", seatsDrawn > 150, `${seatsDrawn} px`);
    const nodeOf = (id: string) => all().find((c) => c.name === `node ${id}`)!;
    const gw = doc.width * 0.3 * ghost!.transform.scaleX;
    const gx0 = ghost!.transform.x * doc.width - gw / 2;
    check("nodes sit in the ghost's seats",
      Math.abs(nodeOf("a").transform.x * doc.width - (gx0 + gw / 4)) < 1 && Math.abs(nodeOf("b").transform.x * doc.width - (gx0 + (gw * 3) / 4)) < 1);
    const ringless = (t: number) => frame(without(doc, (c) => c.role !== "flash"), t);
    const ringAt = differ(frame(doc, 2.5), ringless(2.5));
    const ringAfter = differ(frame(doc, 3.0), ringless(3.0));
    check("a node that arrives with flash gets a ring, which is gone 0.7 s later", ringAt > 100 && ringAfter === 0, `${ringAt} px during, ${ringAfter} after`);

    addCoin(ctx, { stops: [{ at: 4, target: { node: "a" } }, { at: 6, target: { node: "you" } }] });
    const coin = all().find((c) => c.role === "coin")!;
    const coinAt = (t: number) => clipAt(coin, t - coin.start).transform;
    const [ax, ay, rx, ry] = [nodeOf("a").transform.x, nodeOf("a").transform.y, nodeOf("you").transform.x, nodeOf("you").transform.y];
    const mid = coinAt(5.55);
    check("a coin waits at its stop, then travels to arrive on time",
      Math.abs(coinAt(4.8).x - ax) < 1e-3 && Math.abs(mid.x - (ax + rx) / 2) < 2e-3 && Math.abs(mid.y - (ay + ry) / 2) < 2e-3 && Math.abs(coinAt(6).x - rx) < 1e-3,
      `mid ${mid.x.toFixed(3)},${mid.y.toFixed(3)} vs ${((ax + rx) / 2).toFixed(3)},${((ay + ry) / 2).toFixed(3)}`);
    const coinPx = differ(frame(doc, 5.55), frame(without(doc, (c) => c.role !== "coin"), 5.55), mid.x * doc.width - 8, mid.y * doc.height - 8, mid.x * doc.width + 8, mid.y * doc.height + 8);
    check("and is drawn where it is, fading in and out", coinPx > 20 && coinAt(3.8).opacity < 1 && coinAt(6.5).opacity < 0.2, `${coinPx} px`);

    // A figure counts up the way it was written, in a box that does not move.
    const figure = parseFigure("₹1,26,000");
    check("a figure is read as written: Indian grouping and a prefix",
      figure?.locale === "en-IN" && figure.to === 126000 && figure.prefix === "₹" && formatCount(figure, 126000) === "₹1,26,000", JSON.stringify(figure));
    check("counting keeps that grouping on the way", figure !== null && formatCount(figure, 63000) === "₹63,000" && formatCount(figure, 1260000) === "₹12,60,000");
    check("text that is not one plain figure is not counted",
      parseFigure("Level 4 of 9") === null && parseFigure("12.5% APY")?.decimals === 1 && parseFigure("46,656 seats")?.locale === "en-US");
    doc = fresh("counter");
    addStat(ctx, { start: 1, end: 6, value: "₹1,26,000", label: "a year", count: true });
    const stat = all().find((c) => c.role === "stat")!;
    const midway = counterText(clipAt(stat, 0.5).text!);
    check("add_stat with count counts up to the value as written",
      stat.text?.counter?.to === 126000 && midway !== "₹1,26,000" && counterText(clipAt(stat, 3).text!) === "₹1,26,000", `${midway} half a second in`);
    const statBox = (t: number) => clipBox(doc, clipAt(stat, t - stat.start), null, false)!;
    check("its box is the final figure's all the way", Math.abs(statBox(1.2).w - statBox(4).w) < 0.01);
    const statLint = await lintScene(doc, { from: 1, to: 6, contrast: false });
    check("the label beside a counting stat clears its tabular figure", !statLint.issues.some((i) => i.kind === "overlap"), statLint.issues.map((i) => i.detail).join(" | "));
    const tally = textClip(0, 4);
    tally.text = { ...tally.text!, content: "46,656", align: "right", fontSize: 120, color: "#ffffff", counter: parseFigure("46,656")!, counterValue: 1 };
    tally.textAnimation = "none";
    tally.transform = { ...tally.transform, x: 0.8, y: 0.5 };
    tally.keyframes = [
      { id: "k0", property: "text.counterValue", time: 0, value: 0, easing: "linear" },
      { id: "k1", property: "text.counterValue", time: 2, value: 1, easing: "hold" },
    ];
    const lone: Project = { ...fresh("tally"), tracks: [{ ...emptyTrack("video", "T"), clips: [tally] }] };
    const rightEdge = (t: number) => {
      const c = frame(lone, t);
      const data = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
      let right = -1;
      for (let i = 0; i < data.length; i += 4) if (data[i]! > 180 && data[i + 1]! > 180 && data[i + 2]! > 180) right = Math.max(right, (i / 4) % c.canvas.width);
      return right;
    };
    // 0.65 of the way is 30,326: the same last digit as 46,656.
    check("a right-aligned count keeps its right edge still", rightEdge(1.3) > 0 && Math.abs(rightEdge(1.3) - rightEdge(3)) <= 2, `${rightEdge(1.3)} vs ${rightEdge(3)}`);
    const onScreen = scanNumbers(doc).filter((n) => n.shown.some((x) => x.clipId === stat.id)).map((n) => n.value.replace(/\D/g, ""));
    check("the fact check reads the figure it counts to, not the numbers on the way", onScreen.length === 1 && onScreen[0] === "126000", onScreen.join());
    const fixed = reduce(doc, { type: "correctFact", id: "f-count", from: "1,26,000", to: "1,29,600" }).tracks.flatMap((t) => t.clips).find((c) => c.id === stat.id)!;
    check("correcting the figure changes what it counts to", fixed.text?.counter?.to === 129600 && settledText(fixed.text!) === "₹1,29,600", settledText(fixed.text!));

    // The export draws in a worker: Path2D and DOMMatrix have to exist there too.
    const still = newProject("path export");
    still.width = 640;
    still.height = 360;
    const plate = shapeClip(0, 1);
    plate.shape = { ...plate.shape!, kind: "path", path: "M0.25 0.25L0.75 0.25L0.75 0.75L0.25 0.75Z", fill: "#ff2020", strokeWidth: 0 };
    plate.transform = { ...plate.transform, x: 0.5, y: 0.5, scaleX: 1 / 0.3, scaleY: 1 / 0.3 };
    still.tracks.find((t) => t.kind === "video")!.clips = [plate];
    still.inPoint = 0;
    still.outPoint = 1;
    const shot = await frameCanvas(await exportProject(still, { container: "mp4", height: 360, frameRate: 30, quality: "high", bitrateMbps: null, useInOut: true }), 0.5);
    const inside = shot ? sample(shot, shot.canvas.width / 2, shot.canvas.height / 2) : { r: 0, g: 0, b: 0 };
    const outside = shot ? sample(shot, 20, 20) : { r: 255, g: 0, b: 0 };
    check("a path shape reaches the export, drawn in its box's own units", isRed(inside) && !isRed(outside), `${describe(inside)} inside, ${describe(outside)} outside`);

    const countStill = newProject("count export");
    countStill.width = 640;
    countStill.height = 360;
    const big = textClip(0, 2);
    big.text = { ...big.text!, content: "100,000", fontSize: 140, color: "#ffffff", counter: parseFigure("100,000")!, counterValue: 1 };
    big.textAnimation = "none";
    big.keyframes = [
      { id: "c0", property: "text.counterValue", time: 0, value: 0, easing: "hold" },
      { id: "c1", property: "text.counterValue", time: 1, value: 1, easing: "hold" },
    ];
    countStill.tracks.find((t) => t.kind === "video")!.clips = [big];
    countStill.inPoint = 0;
    countStill.outPoint = 2;
    const countBlob = await exportProject(countStill, { container: "mp4", height: 360, frameRate: 30, quality: "high", bitrateMbps: null, useInOut: true });
    const zeroShot = await frameCanvas(countBlob, 0.5);
    const fullShot = await frameCanvas(countBlob, 1.5);
    const zeroPx = zeroShot ? brightPixelsInBand(zeroShot, 180, 90) : 0;
    const fullPx = fullShot ? brightPixelsInBand(fullShot, 180, 90) : 0;
    check("a count reaches the export: 0 first, then the whole figure", zeroPx > 50 && fullPx > zeroPx * 3, `${zeroPx} px at 0.5 s, ${fullPx} at 1.5 s`);
  }

  /* --- generated stills: a bin, a B-roll track, covering, a slow move --- */
  log("\ngenerated stills", "dim");
  {
    // A still as a service would send one, in a shape that is not the frame's.
    const canvas = document.createElement("canvas");
    canvas.width = 768;
    canvas.height = 512;
    const g = canvas.getContext("2d")!;
    const gradient = g.createLinearGradient(0, 0, 768, 0);
    gradient.addColorStop(0, "#ff3030");
    gradient.addColorStop(1, "#3030ff");
    g.fillStyle = gradient;
    g.fillRect(0, 0, 768, 512);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const { assets: stills } = await importFiles([new File([blob], "still.png", { type: "image/png" })]);
    const still = stills[0];
    check("a generated PNG imports as a picture, at its size", still?.kind === "image" && still.width === 768 && still.height === 512, still ? `${still.kind} ${still.width}×${still.height}` : "not imported");
    if (still) {
      let doc: Project = { ...newProject("b-roll"), width: 960, height: 540 };
      const ctx = { project: () => doc, commit: (action: Action) => { doc = reduce(doc, action); } };
      const placed = placeImage(ctx, still, { start: 1, duration: 4, motion: "push-in" });
      const track = doc.tracks.find((t) => t.id === placed?.trackId);
      const clip = track?.clips[0];
      const firstVideo = doc.tracks.findIndex((t) => t.kind === "video");
      check("it lands in an Images bin, on a video track above the first",
        track?.kind === "video" && doc.tracks.indexOf(track) > firstVideo && doc.bins.some((b) => b.name === "Images" && b.id === doc.assets[0]?.binId));
      const cover = coverScale(doc, still);
      check("it covers the frame and pushes in over its length, keyed from the clip's start",
        Boolean(clip) && Math.abs(cover - (960 / 540) / (768 / 512)) < 1e-9 && clip!.start === 1 && clip!.duration === 4 &&
          Math.abs((valueAt(clip!, "transform.scale", 0) ?? 0) - cover) < 1e-9 && Math.abs((valueAt(clip!, "transform.scale", 4) ?? 0) - cover * 1.08) < 1e-9);
      const beside = placeImage(ctx, still, { start: 2, duration: 2, motion: "pan-left" });
      // A title on screen over that stretch: the still goes between the picture and the title, not over it.
      let titled: Project = { ...newProject("titled"), width: 960, height: 540 };
      const titledCtx = { project: () => titled, commit: (action: Action) => { titled = reduce(titled, action); } };
      titledCtx.commit({ type: "addTrack", kind: "video" });
      const titleTrack = titled.tracks.filter((t) => t.kind === "video")[1]!;
      titledCtx.commit({ type: "addClip", trackId: titleTrack.id, clip: { ...textClip(0, 6), text: { ...textClip(0, 6).text!, content: "Scene title" } } });
      const under = placeImage(titledCtx, still, { start: 1, duration: 4, motion: "push-in" });
      const stillIndex = titled.tracks.findIndex((t) => t.id === under?.trackId);
      const titleIndex = titled.tracks.findIndex((t) => t.id === titleTrack.id);
      check("under a title on screen, a still goes between the picture and the title", stillIndex > titled.tracks.findIndex((t) => t.kind === "video") && stillIndex < titleIndex, `still on track ${stillIndex}, title on ${titleIndex}`);
      check("a still overlapping it goes on another track, and a pan slides it",
        Boolean(beside) && beside!.trackId !== placed?.trackId && kenBurnsKeys("pan-left", 2, 1).some((k) => k.property === "transform.x" && k.time === 2 && k.value === 0.48));
    }
    let looks = reduce(newProject("looks"), { type: "setImageStyle", style: { id: "look", name: "Documentary", model: "z_image_turbo_1.0_q8p.ckpt", prompt: "soft window light, muted palette", width: 1536, height: 896, createdAt: 1, updatedAt: 1 } });
    looks = reduce(looks, { type: "setImageStyle", style: { ...looks.imageStyles[0]!, prompt: "hard noon light", updatedAt: 2 } });
    check("a look is saved once and updated in place", looks.imageStyles.length === 1 && looks.imageStyles[0]?.prompt === "hard noon light" && looks.imageStyles[0].createdAt === 1);
    check("and removed by id", reduce(looks, { type: "removeImageStyle", styleId: "look" }).imageStyles.length === 0);
  }

  /* --- voice profiles ------------------------------------------------- */
  log("\nvoice profiles", "dim");
  {
    let p = newProject("voices");
    const narrator = { id: "narrator", name: "Narrator", model: "google/gemini-3.1-flash-tts-preview", voice: "Kore", instructions: "Warm", createdAt: 1, updatedAt: 1 };
    p = reduce(p, { type: "setVoiceProfile", profile: narrator });
    p = reduce(p, { type: "setVoiceProfile", profile: { ...narrator, voice: "Puck", updatedAt: 2 } });
    check("a speaker is saved once and updated in place", p.voices.length === 1 && p.voices[0]?.voice === "Puck" && p.voices[0].createdAt === 1);
    const kept = JSON.parse(JSON.stringify(p)) as Project;
    check("speakers survive a save", kept.voices[0]?.instructions === "Warm");
    p = reduce(p, { type: "removeVoiceProfile", profileId: "narrator" });
    check("and are removed by id", p.voices.length === 0);
  }

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
  {
    // Loud audio with no words where the transcript skipped it: a hole an agent must not cut blind.
    const mic = base.assets.find((a) => a.hasAudio && !a.hasVideo) ?? base.assets.find((a) => a.hasAudio)!;
    const heard = (spans: [number, number][]): Project => ({
      ...base,
      assets: base.assets.map((a) =>
        a.id === mic.id
          ? { ...a, transcript: { version: 1, provider: "check", model: "check", language: null, durationSec: mic.durationSec, timing: "word" as const, words: spans.map(([start, end], i) => ({ start, end, text: `w${i}` })), createdAt: 0 } }
          : a,
      ),
    });
    const gappy = heard([[0, 0.4], [0.4, 0.6], [2.6, 2.8]]);
    const holes = transcriptHoles(gappy, 0, 2.8, wordsOnTimeline(gappy));
    check("loud audio with no words is reported as a hole", holes.length === 1 && holes[0]!.start >= 0.5 && holes[0]!.end <= 2.7, JSON.stringify(holes));
    const covered = heard([[0, 0.9], [0.9, 1.8], [1.8, 2.8]]);
    check("and audio with words over it is not", transcriptHoles(covered, 0, 2.8, wordsOnTimeline(covered)).length === 0);
  }
  check(
    "screen is the base layer and camera sits on top",
    base.tracks[0]?.name === "Screen" && base.tracks[1]?.name === "Camera",
    base.tracks.map((t) => t.name).join(" / "),
  );
  const pip = base.tracks[1]?.clips[0]?.transform;
  check("camera is auto-placed as a circular PiP",
    pip?.shape === "circle" && pip.scale < 0.5, `${pip?.shape} at ${pip?.scale}`);

  {
    // Rows by what they hold: footage and sound read closely, a lane of titles thin.
    const withTitles = reduce(base, { type: "addTrack", kind: "video" });
    const titles = withTitles.tracks[withTitles.tracks.length - 1]!;
    const lanes = { ...withTitles, tracks: withTitles.tracks.map((t) => (t.id === titles.id ? { ...t, clips: [textClip(0, 2)] } : t)) };
    const heights = lanes.tracks.map((t) => `${t.name}:${rowHeight(lanes, t, "normal")}`).join(" ");
    check("footage and sound rows are tall, a lane of titles is thin",
      lanes.tracks.filter((t) => t.id !== titles.id).every((t) => rowHeight(lanes, t, "normal") === 48) && rowHeight(lanes, lanes.tracks.find((t) => t.id === titles.id)!, "normal") === 24, heights);
  }

  const duration = projectDuration(base);
  check("timeline length matches the take",
    Math.abs(duration - meta.durationMs / 1000) < 0.8,
    `${duration.toFixed(2)}s vs ${(meta.durationMs / 1000).toFixed(2)}s`);

  /* --- an SVG, through import and export ----------------------------------- */
  log("\nan SVG logo", "dim");
  {
    // No width or height, only a viewBox: the case that failed at probing.
    const svg = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#ff2020"/></svg>'],
      "logo.svg",
      { type: "image/svg+xml" },
    );
    const { assets: imported, failed } = await importFiles([svg]);
    const logo = imported[0];
    check("an SVG imports, rasterised at its own aspect",
      Boolean(logo) && logo!.kind === "image" && logo!.width === 2048 && logo!.height === 1024 && logo!.mimeType === "image/png",
      logo ? `${logo.width}×${logo.height} ${logo.mimeType}` : (failed[0]?.reason ?? "not imported"));
    check("the original SVG is kept beside it, and it has a thumbnail", Boolean(logo?.vectorSource) && Boolean(logo?.thumbnail));
    if (logo) {
      const still = newProject("svg export");
      still.width = 1280;
      still.height = 720;
      still.assets = [logo];
      still.tracks.find((t) => t.kind === "video")!.clips = [newMediaClip(logo, 0)];
      still.inPoint = 0;
      still.outPoint = 1;
      const exported = await exportProject(still, { container: "mp4", height: 360, frameRate: 30, quality: "high", bitrateMbps: null, useInOut: true });
      const frame = await frameCanvas(exported, 0.5);
      const [r = 0, g = 0, b = 0] = frame ? Array.from(frame.getImageData(frame.canvas.width / 2, frame.canvas.height / 2, 1, 1).data) : [];
      check("the logo reaches the exported file", r > 180 && g < 90 && b < 90, `centre rgb ${r},${g},${b}`);
    }
  }

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
