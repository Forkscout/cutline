/**
 * What is in a video before an agent decides how to cut it: graphics already
 * burned into it, where the subject sits, where the shots change, where it
 * goes quiet.
 *
 * The TreeFlux source had its own "Smart Contract" card from 1 to 21.5 s. A
 * panel cropped around the speaker sliced it into a sliver, and it was found
 * only by decoding frames with ffmpeg and diffing them by hand. This does the
 * same in the tab: small grey frames at a steady rate, a median frame per shot
 * as the background, and three questions of the differences — what appears
 * and stays (an overlay), what flickers in one place (a person), what changes
 * everywhere at once (a cut).
 */

import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from "mediabunny";
import { PEAKS_PER_SECOND, assetUrl } from "./media";
import type { MediaAsset } from "./types";

export interface MediaAnalysis {
  asset: string;
  durationSec: number;
  sampledEverySec: number;
  /** Where the subject sits across the source, 0..1, from where the picture moves. */
  subjectX: number | null;
  subjectConfidence: "high" | "low" | null;
  /** Seconds where the whole picture changes: shot boundaries. */
  cuts: number[];
  /** Stretches where something appears over a still part of the picture — graphics burned into the video. */
  overlays: { start: number; end: number; region: "left" | "centre" | "right"; strength: number }[];
  silences: { start: number; end: number }[];
  notes: string[];
}

const GW = 64;
const GH = 36;
const MAX_FRAMES = 600;

const regions = [
  { name: "left" as const, x0: 0, x1: 21 },
  { name: "centre" as const, x0: 21, x1: 43 },
  { name: "right" as const, x0: 43, x1: GW },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function silencesOf(asset: MediaAsset): { start: number; end: number }[] {
  const peaks = asset.peaks;
  if (!asset.hasAudio || !peaks?.length) return [];
  const out: { start: number; end: number }[] = [];
  let from: number | null = null;
  const buckets = peaks.length / 2;
  for (let i = 0; i <= buckets; i += 1) {
    const level = i < buckets ? Math.max(Math.abs(peaks[i * 2] ?? 0), Math.abs(peaks[i * 2 + 1] ?? 0)) : 1;
    if (level < 0.02) from ??= i;
    else if (from !== null) {
      if ((i - from) / PEAKS_PER_SECOND >= 0.5) out.push({ start: round(from / PEAKS_PER_SECOND), end: round(i / PEAKS_PER_SECOND) });
      from = null;
    }
  }
  return out.slice(0, 60);
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function analyzeAsset(asset: MediaAsset, onProgress?: (fraction: number) => void): Promise<MediaAnalysis> {
  const base: MediaAnalysis = {
    asset: asset.name,
    durationSec: asset.durationSec,
    sampledEverySec: 0,
    subjectX: null,
    subjectConfidence: null,
    cuts: [],
    overlays: [],
    silences: silencesOf(asset),
    notes: [],
  };
  if (!asset.hasVideo || asset.kind === "image") {
    base.notes.push(asset.kind === "image" ? "A still image: nothing moves, nothing to find." : "Sound only: silences are all there is to find.");
    return base;
  }

  const every = Math.max(0.5, asset.durationSec / MAX_FRAMES);
  const times: number[] = [];
  for (let t = 0.05; t < asset.durationSec - 0.05; t += every) times.push(Math.round(t * 1000) / 1000);
  const input = new Input({ source: new UrlSource(assetUrl(asset)), formats: ALL_FORMATS });
  const frames: Uint8Array[] = [];
  const at: number[] = [];
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("The file has no video track.");
    const sink = new VideoSampleSink(track);
    const canvas = new OffscreenCanvas(GW, GH);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not get a 2D context.");
    let i = 0;
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (sample) {
        ctx.drawImage(sample.toCanvasImageSource(), 0, 0, GW, GH);
        sample.close();
        const rgba = ctx.getImageData(0, 0, GW, GH).data;
        const grey = new Uint8Array(GW * GH);
        for (let p = 0; p < grey.length; p += 1) grey[p] = (rgba[p * 4]! * 299 + rgba[p * 4 + 1]! * 587 + rgba[p * 4 + 2]! * 114) / 1000;
        frames.push(grey);
        at.push(times[i]!);
      }
      i += 1;
      if (i % 20 === 0) onProgress?.(i / times.length);
    }
  } finally {
    input.dispose();
  }
  base.sampledEverySec = round(every);
  if (frames.length < 3) {
    base.notes.push("Too few frames decoded to say anything.");
    return base;
  }

  // Cuts: the whole picture changes between two samples.
  const diff = (a: Uint8Array, b: Uint8Array) => {
    let sum = 0;
    for (let p = 0; p < a.length; p += 1) sum += Math.abs(a[p]! - b[p]!);
    return sum / a.length;
  };
  const cutAt = new Set<number>();
  for (let k = 1; k < frames.length; k += 1) if (diff(frames[k]!, frames[k - 1]!) > 32) cutAt.add(k);
  base.cuts = [...cutAt].map((k) => round(at[k]!));

  // The subject: where the picture moves, frame to frame, outside cuts.
  const energy = new Array<number>(GW).fill(0);
  for (let k = 1; k < frames.length; k += 1) {
    if (cutAt.has(k)) continue;
    for (let y = 0; y < GH; y += 1) for (let x = 0; x < GW; x += 1) energy[x]! += Math.abs(frames[k]![y * GW + x]! - frames[k - 1]![y * GW + x]!);
  }
  const total = energy.reduce((n, v) => n + v, 0);
  if (total > 0) {
    const centre = energy.reduce((n, v, x) => n + v * (x + 0.5), 0) / total;
    const near = energy.reduce((n, v, x) => (Math.abs(x + 0.5 - centre) <= GW * 0.16 ? n + v : n), 0) / total;
    base.subjectX = round(centre / GW);
    base.subjectConfidence = near > 0.55 ? "high" : "low";
  }

  // The region the person is in moves all the time — a hand, a lean — so only
  // a long appearance there counts as a graphic.
  const subjectRegion = base.subjectX === null ? null : regions.find((r) => base.subjectX! * GW >= r.x0 && base.subjectX! * GW < r.x1)?.name;

  // Overlays, shot by shot: against that shot's median frame.
  const flaggedFrames = new Set<number>();
  const bounds = [0, ...[...cutAt].sort((a, b) => a - b), frames.length];
  for (let s = 0; s + 1 < bounds.length; s += 1) {
    const [from, to] = [bounds[s]!, bounds[s + 1]!];
    if (to - from < 5) continue;
    const med = new Uint8Array(GW * GH);
    for (let p = 0; p < med.length; p += 1) {
      const column: number[] = [];
      for (let k = from; k < to; k += 1) column.push(frames[k]![p]!);
      med[p] = median(column);
    }
    for (const region of regions) {
      const shares: number[] = [];
      for (let k = from; k < to; k += 1) {
        let changed = 0;
        let total = 0;
        for (let y = 0; y < GH - 2; y += 1) {
          for (let x = region.x0; x < region.x1; x += 1) {
            total += 1;
            if (Math.abs(frames[k]![y * GW + x]! - med[y * GW + x]!) > 40) changed += 1;
          }
        }
        shares.push(changed / total);
      }
      const baseline = median(shares);
      const threshold = Math.max(0.06, baseline * 2 + 0.03);
      let open: number | null = null;
      for (let j = 0; j <= shares.length; j += 1) {
        const on = j < shares.length && shares[j]! > threshold;
        if (on && open === null) open = j;
        if (!on && open !== null) {
          const start = at[from + open]!;
          const end = at[from + j - 1]! + every;
          if (end - start >= (region.name === subjectRegion ? 3 : 1)) {
            const strength = shares.slice(open, j).reduce((n, v) => n + v, 0) / (j - open);
            base.overlays.push({ start: round(start), end: round(end), region: region.name, strength: round(strength) });
            for (let q = open; q < j; q += 1) flaggedFrames.add(from + q);
          }
          open = null;
        }
      }
    }
  }
  base.overlays.sort((a, b) => a.start - b.start);

  if (base.overlays.length) {
    base.notes.push(
      `Graphics already in the video: ${base.overlays.map((o) => `${o.start}–${o.end} s (${o.region})`).join(", ")}. Keep full frame there, or a panel's crop will slice them.`,
    );
  }
  base.notes.push(base.cuts.length ? `${base.cuts.length + 1} shots.` : "One continuous shot.");
  if (base.subjectX !== null) base.notes.push(`Subject at ${base.subjectX} across the frame (${base.subjectConfidence} confidence): layout_move's subjectX.`);
  return base;
}

/** One analysis per asset per page, shared by repeat calls. */
const running = new Map<string, { promise: Promise<MediaAnalysis>; progress: number }>();

export function analysisOf(asset: MediaAsset): { promise: Promise<MediaAnalysis>; progress: number } {
  let entry = running.get(asset.id);
  if (!entry) {
    const created: { promise: Promise<MediaAnalysis>; progress: number } = { promise: Promise.resolve(null as unknown as MediaAnalysis), progress: 0 };
    created.promise = analyzeAsset(asset, (f) => (created.progress = f)).catch((err: unknown) => {
      running.delete(asset.id);
      throw err;
    });
    running.set(asset.id, created);
    entry = created;
  }
  return entry;
}
