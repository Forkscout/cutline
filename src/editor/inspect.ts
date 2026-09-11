/**
 * Reading a project the way an agent needs to: compactly, as a diff, and by
 * ear. Pure functions of the document — nothing here touches media or the DOM.
 */

import { assetTimeFor } from "./compositor";
import { PEAKS_PER_SECOND } from "./media";
import { fadeGainAt, projectDuration, trackAudible } from "./project";
import type { Clip, Project } from "./types";

/**
 * The project without thumbnails and waveform peaks. Those are most of its
 * bytes and none of its meaning, and an agent pays for every one of them.
 */
export function leanProject(project: Project): Project {
  return {
    ...project,
    assets: project.assets.map(({ thumbnail: _t, peaks: _p, ...asset }) => asset),
  };
}

/* ------------------------------------------------------------------ diffs */

export interface ClipSummary {
  trackId: string;
  clipId: string;
  kind: Clip["kind"];
  name: string;
  start: number;
  duration: number;
}

export interface ChangeSummary {
  added: ClipSummary[];
  removed: ClipSummary[];
  changed: ClipSummary[];
  /** Every id that did not exist before — new effects, keyframes, markers, tracks. */
  newIds: string[];
  duration: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function clipIndex(project: Project): Map<string, { summary: ClipSummary; json: string }> {
  const out = new Map<string, { summary: ClipSummary; json: string }>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      out.set(clip.id, {
        summary: {
          trackId: track.id,
          clipId: clip.id,
          kind: clip.kind,
          name: clip.name,
          start: round(clip.start),
          duration: round(clip.duration),
        },
        json: `${track.id}|${JSON.stringify(clip)}`,
      });
    }
  }
  return out;
}

function collectIds(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "id" && typeof v === "string") into.add(v);
      else if (typeof v === "object") collectIds(v, into);
    }
  }
  return into;
}

/** What an edit did, so the agent learns new ids without re-reading the project. */
export function describeChange(before: Project, after: Project): ChangeSummary {
  const was = clipIndex(before);
  const now = clipIndex(after);
  const added: ClipSummary[] = [];
  const changed: ClipSummary[] = [];
  for (const [id, entry] of now) {
    const old = was.get(id);
    if (!old) added.push(entry.summary);
    else if (old.json !== entry.json) changed.push(entry.summary);
  }
  const removed = [...was].filter(([id]) => !now.has(id)).map(([, e]) => e.summary);
  const oldIds = collectIds(before, new Set());
  const newIds = [...collectIds(after, new Set())].filter((id) => !oldIds.has(id));
  return { added, removed, changed, newIds, duration: round(projectDuration(after)) };
}

/* ---------------------------------------------------------------- hearing */

/** Below this the mix is treated as silent: about -34 dBFS. */
const SILENCE_LEVEL = 0.02;
/** Shorter gaps are breaths and cuts, not problems. */
const SILENCE_MIN_SEC = 0.5;
const CLIP_LEVEL = 0.99;

export interface Envelope {
  start: number;
  end: number;
  bucketSec: number;
  /** Peak level per bucket, 0..1 (1 is full scale). */
  levels: number[];
  silences: { start: number; end: number }[];
  clipping: { start: number; end: number }[];
  /** Clips whose sound could not be measured, because no waveform was computed. */
  unmeasured: string[];
}

/**
 * Peak loudness of the mix, from the waveform peaks computed at import.
 *
 * Levels from overlapping clips are summed, which overstates a mix slightly
 * but never hides a clipped peak — the direction worth erring in.
 */
export function audioEnvelope(project: Project, start: number, end: number, buckets = 60): Envelope {
  const span = Math.max(0.001, end - start);
  const bucketSec = span / buckets;
  const step = 1 / PEAKS_PER_SECOND;
  const levels = new Array<number>(buckets).fill(0);
  const unmeasured = new Set<string>();

  for (const track of project.tracks) {
    if (!trackAudible(project, track)) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.muted || clip.kind !== "media") continue;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset?.hasAudio) continue;
      const peaks = asset.peaks;
      if (!peaks?.length) {
        unmeasured.add(clip.name);
        continue;
      }
      const from = Math.max(start, clip.start);
      const to = Math.min(end, clip.start + clip.duration);
      for (let t = from; t < to; t += step) {
        const i = Math.floor(assetTimeFor(clip, t) * PEAKS_PER_SECOND);
        const amp = Math.max(Math.abs(peaks[i * 2] ?? 0), Math.abs(peaks[i * 2 + 1] ?? 0));
        const level = amp * clip.volume * fadeGainAt(clip, t);
        const b = Math.min(buckets - 1, Math.floor((t - start) / bucketSec));
        levels[b] = Math.max(levels[b] ?? 0, level);
      }
    }
  }

  const runs = (test: (level: number) => boolean, minSec: number) => {
    const out: { start: number; end: number }[] = [];
    let runStart: number | null = null;
    levels.forEach((level, i) => {
      const t = start + i * bucketSec;
      if (test(level)) runStart ??= t;
      else if (runStart !== null) {
        if (t - runStart >= minSec) out.push({ start: round(runStart), end: round(t) });
        runStart = null;
      }
    });
    if (runStart !== null && end - runStart >= minSec) out.push({ start: round(runStart), end: round(end) });
    return out;
  };

  return {
    start: round(start),
    end: round(end),
    bucketSec: round(bucketSec),
    levels: levels.map(round),
    silences: runs((l) => l < SILENCE_LEVEL, SILENCE_MIN_SEC),
    clipping: runs((l) => l >= CLIP_LEVEL, 0),
    unmeasured: [...unmeasured],
  };
}
