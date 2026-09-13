/**
 * Cutting a stretch of time out of the whole edit.
 *
 * "Remove these seven sentences" is the most ordinary edit there is, and it
 * used to take a new project document written outside the editor. A cut
 * removes [from, to) from every track at once: clips inside it go, a clip
 * across a boundary is split with its source and its animation continuous
 * (`sliceKeyframes`), and everything after closes up by the removed length —
 * markers, the in and out points, captions, facts and the storyboard's time
 * anchors with it. Words need nothing: they live in the source and follow
 * their clips.
 *
 * A locked track is never skipped. A cut that ripples some tracks and not
 * others desyncs the edit, so one that would change a locked track is refused
 * (`lockedTracksIn`) instead.
 */

import { keyframesFor, sliceKeyframes } from "./keyframes";
import type { CaptionCue, Clip, Project, Track } from "./types";
import type { TimelineWord } from "./transcript";

const EPS = 1e-6;
/** A piece shorter than this, left by a cut, is not worth a clip. */
const MIN_PIECE = 1 / 120;

/** Where a moment lands once [from, to) is gone: before stays, inside goes to `from`, after closes up. */
export const afterCut = (t: number, from: number, to: number): number => (t <= from ? t : t >= to ? t - (to - from) : from);

/** Locked tracks with anything at or after `from`: a cut would have to leave them behind. */
export function lockedTracksIn(project: Project, from: number): Track[] {
  return project.tracks.filter((t) => t.locked && t.clips.some((c) => c.start + c.duration > from + EPS));
}

interface Pieces {
  head: Clip | null;
  tail: Clip | null;
}

function piecesOf(clip: Clip, from: number, to: number): Pieces {
  const start = clip.start;
  const end = clip.start + clip.duration;
  if (end <= from + EPS) return { head: clip, tail: null };
  if (start >= to - EPS) return { head: null, tail: { ...clip, start: start - (to - from) } };
  const head = start < from - MIN_PIECE ? { ...clip, duration: from - start } : null;
  const skipped = to - start;
  const tail =
    end > to + MIN_PIECE
      ? {
          ...structuredClone(clip),
          // Whatever of it survives past the cut begins where the cut was.
          start: from,
          duration: end - to,
          inPoint: skipped > 0 ? clip.inPoint + skipped * clip.speed : clip.inPoint,
          keyframes: skipped > 0 ? sliceKeyframes(clip.keyframes, skipped) : clip.keyframes,
        }
      : null;
  if (head && tail) {
    // One clip became two: the tail is a clip of its own, and nothing that was
    // already on screen transitions or enters again at the join.
    tail.id = crypto.randomUUID();
    tail.keyframes = tail.keyframes.map((k) => ({ ...k, id: crypto.randomUUID() }));
    head.transitionOut = { ...head.transitionOut, type: "none" };
    tail.transitionIn = { ...tail.transitionIn, type: "none" };
    if (tail.kind === "text") tail.textAnimation = "none";
  }
  return { head, tail };
}

/** A `{ time }` storyboard anchor, anywhere in the storyboard, moved with the cut. */
function shiftAnchors(value: unknown, from: number, to: number): unknown {
  if (Array.isArray(value)) return value.map((v) => shiftAnchors(v, from, to));
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (typeof o.time === "number" && !("word" in o) && keys.every((k) => k === "time" || k === "offset")) {
    return { ...o, time: afterCut(o.time, from, to) };
  }
  return Object.fromEntries(keys.map((k) => [k, shiftAnchors(o[k], from, to)]));
}

/** The project with [from, to) cut out of every track. A cut that would leave a locked track behind changes nothing. */
export function cutRange(project: Project, from: number, to: number): Project {
  if (!(to - from > EPS) || lockedTracksIn(project, from).length) return project;
  const at = (t: number) => afterCut(t, from, to);

  // Both halves of a take are cut at the same times, so links survive: heads
  // keep their link, and the tails of a group that was split share a new one.
  const all = project.tracks.map((track) => track.clips.map((clip) => ({ clip, ...piecesOf(clip, from, to) })));
  const split = new Set(all.flat().flatMap((p) => (p.head && p.tail && p.clip.linkId ? [p.clip.linkId] : [])));
  const tailLinks = new Map([...split].map((link) => [link, crypto.randomUUID()]));

  const tracks = project.tracks.map((track, i) => ({
    ...track,
    clips: all[i]!
      .flatMap(({ head, tail }) => {
        if (tail?.linkId && tailLinks.has(tail.linkId)) tail.linkId = tailLinks.get(tail.linkId)!;
        return [head, tail].filter((c): c is Clip => c !== null);
      })
      .sort((a, b) => a.start - b.start),
  }));

  const captions = project.captions
    .map((cue): CaptionCue => ({ ...cue, start: at(cue.start), end: at(cue.end) }))
    .filter((cue) => cue.end - cue.start > 0.05);

  return {
    ...project,
    tracks,
    captions,
    markers: project.markers.map((m) => {
      const start = at(m.time);
      return { ...m, time: start, duration: Math.max(0, at(m.time + m.duration) - start) };
    }),
    inPoint: project.inPoint === null ? null : at(project.inPoint),
    outPoint: project.outPoint === null ? null : at(project.outPoint),
    facts: project.facts.map((f) => (f.time === undefined ? f : { ...f, time: at(f.time) })),
    storyboard: project.storyboard ? (shiftAnchors(project.storyboard, from, to) as Project["storyboard"]) : null,
  };
}

/**
 * A boundary moved off a word: inside one, to the middle of the pause on its
 * nearer side; in a pause, left where it is. Cutting at a word's start rather
 * than the previous word's end is how a word ending a clause vanished, and
 * half of the next survived.
 */
export function snapToWords(words: TimelineWord[], t: number): number {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((w) => w.start < t - EPS && t < w.end - EPS);
  if (i === -1) return t;
  const w = sorted[i]!;
  const before = i > 0 ? Math.min(w.start, (sorted[i - 1]!.end + w.start) / 2) : w.start;
  const after = i + 1 < sorted.length ? Math.max(w.end, (w.end + sorted[i + 1]!.start) / 2) : w.end;
  return t - w.start <= w.end - t ? before : after;
}

/** The range that removes words `first`..`last`, from the middle of the pause before to the middle of the pause after. */
export function rangeOfWords(words: TimelineWord[], first: number, last: number): { from: number; to: number } {
  const a = words[first]!;
  const b = words[last]!;
  const from = first > 0 ? Math.min(a.start, (words[first - 1]!.end + a.start) / 2) : a.start;
  const to = last + 1 < words.length ? Math.max(b.end, (b.end + words[last + 1]!.start) / 2) : b.end;
  return { from, to };
}

/**
 * Animations a boundary would land in the middle of: a property with keys on
 * either side of it, close together and changing — a layout move is a pair
 * ~0.9 s apart. The cut is still exact; this is so nobody is surprised by a
 * move that now happens faster.
 */
export function movesAt(project: Project, t: number): string[] {
  const out: string[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!(clip.start < t - EPS && t < clip.start + clip.duration - EPS)) continue;
      const local = t - clip.start;
      // One line per move, however many properties it animates: a layout move is five of them.
      const windows = new Map<string, string[]>();
      for (const property of new Set(clip.keyframes.map((k) => k.property))) {
        const keys = keyframesFor(clip, property);
        const next = keys.findIndex((k) => k.time > local);
        if (next <= 0) continue;
        const a = keys[next - 1]!;
        const b = keys[next]!;
        if (a.value === b.value || b.time - a.time > 3) continue;
        const window = `${(clip.start + a.time).toFixed(2)}–${(clip.start + b.time).toFixed(2)} s`;
        windows.set(window, [...(windows.get(window) ?? []), property.replace(/^transform\./, "")]);
      }
      for (const [window, properties] of windows) {
        out.push(`The cut at ${t.toFixed(2)} s lands inside a move on "${clip.name}" (${window}: ${properties.join(", ")}) on ${track.name}; it will now happen in less time.`);
      }
    }
  }
  return out;
}

