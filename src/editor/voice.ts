/**
 * Where generated voice goes: into a Voice bin, and onto an audio track with
 * room at the time it should play. The Voice panel and the agent both land a
 * voiceover through this, so they do it the same way.
 */

import { mediaClip, type Action } from "./project";
import type { MediaAsset, Project } from "./types";

export const VOICE_BIN = "Voice";

export interface PlacedVoice {
  trackId: string;
  clipId: string;
  start: number;
  end: number;
}

/**
 * Adds a generated sound to the project, and to the timeline at `start` when
 * given. Each action is committed against the project the one before it made.
 */
export function placeVoice(
  ctx: { project(): Project; commit(action: Action): void },
  asset: MediaAsset,
  start: number | null,
): PlacedVoice | null {
  if (!ctx.project().bins.some((b) => b.name === VOICE_BIN)) ctx.commit({ type: "addBin", name: VOICE_BIN });
  const bin = ctx.project().bins.find((b) => b.name === VOICE_BIN);
  ctx.commit({ type: "addAssets", assets: [{ ...asset, binId: bin?.id ?? null }] });
  if (start === null) return null;

  const end = start + asset.durationSec;
  const room = () =>
    ctx.project().tracks.find((t) => t.kind === "audio" && !t.locked && t.clips.every((c) => c.start >= end - 1e-3 || c.start + c.duration <= start + 1e-3));
  if (!room()) ctx.commit({ type: "addTrack", kind: "audio" });
  const track = room();
  if (!track) throw new Error("Could not find or make an audio track with room for the voice.");
  const clip = mediaClip(asset, start);
  ctx.commit({ type: "addClip", trackId: track.id, clip });
  return { trackId: track.id, clipId: clip.id, start, end };
}
