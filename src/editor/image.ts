/**
 * Where a generated still goes: into an Images bin, and onto a video track
 * above the first as B-roll — covering the frame, with a slow move, because a
 * still that does not move looks dead. The Image panel and the agent both
 * place a still through this, so they do it the same way.
 */

import { mediaClip, type Action } from "./project";
import type { KenBurns, Keyframe, MediaAsset, Project, Track } from "./types";

export const IMAGE_BIN = "Images";

export const KEN_BURNS: KenBurns[] = ["push-in", "pull-out", "pan-left", "pan-right", "none"];

export interface PlacedImage {
  trackId: string;
  clipId: string;
  start: number;
  end: number;
  motion: KenBurns;
}

const key = (property: string, time: number, value: number): Keyframe => ({ id: crypto.randomUUID(), property, time, value, easing: "linear" });

/** How much larger than "fit" a still must be drawn to cover the frame. */
export function coverScale(frame: { width: number; height: number }, image: { width: number; height: number }): number {
  if (!(image.width > 0) || !(image.height > 0)) return 1;
  const frameShape = frame.width / frame.height;
  const imageShape = image.width / image.height;
  return Math.max(frameShape / imageShape, imageShape / frameShape);
}

/**
 * Keys for a slow move across a clip, clip-relative, on top of the scale that
 * covers the frame: 8% over the clip's length. A pan draws the still a little
 * larger so it has room to slide.
 */
export function kenBurnsKeys(motion: KenBurns, duration: number, cover: number): Keyframe[] {
  const end = Math.max(0.1, duration);
  switch (motion) {
    case "push-in":
      return [key("transform.scale", 0, cover), key("transform.scale", end, cover * 1.08)];
    case "pull-out":
      return [key("transform.scale", 0, cover * 1.08), key("transform.scale", end, cover)];
    case "pan-left":
      return [key("transform.scale", 0, cover * 1.08), key("transform.x", 0, 0.52), key("transform.x", end, 0.48)];
    case "pan-right":
      return [key("transform.scale", 0, cover * 1.08), key("transform.x", 0, 0.48), key("transform.x", end, 0.52)];
    default:
      return [];
  }
}

export interface ImagePlacement {
  trackId?: string;
  start: number;
  duration: number;
  motion: KenBurns;
}

/**
 * Adds a generated still to the project, and to the timeline when a placement
 * is given. Each action is committed against the project the one before it made.
 */
export function placeImage(ctx: { project(): Project; commit(action: Action): void }, asset: MediaAsset, place: ImagePlacement | null): PlacedImage | null {
  if (!ctx.project().bins.some((b) => b.name === IMAGE_BIN)) ctx.commit({ type: "addBin", name: IMAGE_BIN });
  const bin = ctx.project().bins.find((b) => b.name === IMAGE_BIN);
  ctx.commit({ type: "addAssets", assets: [{ ...asset, binId: bin?.id ?? null }] });
  if (!place) return null;

  const start = Math.max(0, place.start);
  const end = start + place.duration;
  const free = (t: Track) => t.kind === "video" && !t.locked && t.clips.every((c) => c.start >= end - 1e-3 || c.start + c.duration <= start + 1e-3);
  let track: Track | undefined;
  if (place.trackId) {
    track = ctx.project().tracks.find((t) => t.id === place.trackId);
    if (!track) throw new Error(`There is no track ${place.trackId}.`);
    if (!free(track)) throw new Error(`${track.name} cannot take it: it is not a video track, is locked, or has a clip between ${start.toFixed(2)} and ${end.toFixed(2)} s.`);
  } else {
    // Above the first video track, where the speaker usually is, so the still cuts away from them.
    const pick = () => {
      const tracks = ctx.project().tracks;
      const first = tracks.findIndex((t) => t.kind === "video");
      return tracks.find((t, i) => i > first && free(t));
    };
    track = pick();
    if (!track) {
      ctx.commit({ type: "addTrack", kind: "video" });
      track = pick();
    }
    if (!track) throw new Error("Could not find or make a video track with room for the image.");
  }

  const cover = coverScale(ctx.project(), asset);
  const clip = mediaClip(asset, start);
  clip.duration = place.duration;
  clip.transform = { ...clip.transform, scale: cover };
  clip.keyframes = kenBurnsKeys(place.motion, place.duration, cover);
  ctx.commit({ type: "addClip", trackId: track.id, clip });
  return { trackId: track.id, clipId: clip.id, start, end, motion: place.motion };
}
