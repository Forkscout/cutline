/**
 * Keyframe evaluation.
 *
 * Keyframe times are stored relative to the clip's own start, not the
 * timeline's. That way moving a clip along the timeline, or trimming its head,
 * does not silently re-time every animation on it — which is the behaviour
 * people expect and the one that is annoying to retrofit later.
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
