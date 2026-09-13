/**
 * Keyframe evaluation.
 *
 * Keyframe times are stored relative to the clip's own start, so moving a
 * clip along the timeline carries its animation with it. Edits that change
 * where a clip begins without moving what it shows — a head trim, a split, a
 * cut — re-base the keys with `sliceKeyframes`, so the animation stays where
 * it was on the timeline.
 */

import type { Clip, Easing, Keyframe } from "./types";

const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  ease: (t) => t * t * (3 - 2 * t),
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  // Hold keeps the previous value until the next keyframe is reached, which is
  // how you animate something that should not interpolate at all.
  hold: () => 0,
};

/** Reads a dot path like "transform.scale" off a clip. */
export function readProperty(clip: Clip, path: string): number | undefined {
  let current: unknown = clip;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" ? current : undefined;
}

/** Returns a copy of `clip` with `path` set to `value`. */
export function writeProperty(clip: Clip, path: string, value: number): Clip {
  const parts = path.split(".");
  const clone = structuredClone(clip);
  let current = clone as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const next = current[key];
    if (next === null || typeof next !== "object") return clip;
    current = next as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
  return clone;
}

export function keyframesFor(clip: Clip, path: string): Keyframe[] {
  return clip.keyframes.filter((k) => k.property === path).sort((a, b) => a.time - b.time);
}

/**
 * The keys for a stretch of a clip, `from` to `to` seconds into it, re-based so
 * the stretch starts at 0. Per property it keeps the last key before `from`,
 * every key inside, and the first key at or after `to` — so the stretch
 * interpolates exactly as the whole clip did. A layout held past its last key
 * stays held, and a cut in the middle of a move opens mid-move rather than on
 * the next key's value. Keys kept from outside the stretch sit at negative
 * times or past its end, and `valueAt` reads them like any other.
 *
 * A split used to give the tail only the keys after the split point: on a
 * speaker held in a side panel, the tail had no keys at all and snapped back
 * to full frame.
 */
export function sliceKeyframes(keyframes: Keyframe[], from: number, to = Number.POSITIVE_INFINITY): Keyframe[] {
  const out: Keyframe[] = [];
  for (const property of new Set(keyframes.map((k) => k.property))) {
    const keys = keyframes.filter((k) => k.property === property).sort((a, b) => a.time - b.time);
    const inside = keys.findIndex((k) => k.time >= from);
    // Needed unless a key sits exactly at the start of the stretch.
    const before = inside === -1 ? keys.length - 1 : keys[inside]!.time === from ? inside : inside - 1;
    const after = keys.findIndex((k) => k.time >= to);
    const end = after === -1 ? keys.length : after + 1;
    for (const k of keys.slice(Math.max(0, before), end)) out.push({ ...k, time: k.time - from });
  }
  return out;
}

export function animatedProperties(clip: Clip): string[] {
  return [...new Set(clip.keyframes.map((k) => k.property))].sort();
}

/**
 * The value of one animated property at `localTime` seconds into the clip.
 * Returns undefined when the property has no keyframes, so callers can fall
 * back to the clip's static value.
 */
export function valueAt(clip: Clip, path: string, localTime: number): number | undefined {
  const keys = keyframesFor(clip, path);
  if (keys.length === 0) return undefined;

  const first = keys[0]!;
  if (localTime <= first.time) return first.value;
  const last = keys[keys.length - 1]!;
  if (localTime >= last.time) return last.value;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (localTime < a.time || localTime > b.time) continue;
    const span = b.time - a.time;
    if (span <= 0) return b.value;
    const t = (localTime - a.time) / span;
    return a.value + (b.value - a.value) * EASINGS[a.easing](t);
  }
  return last.value;
}

/**
 * Applies every animated property, returning the clip as it should be at this
 * instant. Clips with no keyframes are returned untouched — the common case,
 * and worth not cloning for.
 */
export function clipAt(clip: Clip, localTime: number): Clip {
  if (clip.keyframes.length === 0) return clip;
  let result = clip;
  for (const path of animatedProperties(clip)) {
    const value = valueAt(clip, path, localTime);
    if (value !== undefined) result = writeProperty(result, path, value);
  }
  return result;
}

/**
 * When line `index` of a text clip has arrived, in seconds into the clip: the
 * first moment `text.reveal` is half-way through that line. 0 when every line
 * shows from the start, Infinity when this one never does.
 */
export function lineArrivesAt(clip: Clip, index: number): number {
  if (keyframesFor(clip, "text.reveal").length === 0) return (clip.text?.reveal ?? Number.POSITIVE_INFINITY) >= index + 0.5 ? 0 : Number.POSITIVE_INFINITY;
  for (let t = 0; t <= clip.duration; t += 1 / 30) {
    if ((valueAt(clip, "text.reveal", t) ?? 0) >= index + 0.5) return t;
  }
  return Number.POSITIVE_INFINITY;
}
