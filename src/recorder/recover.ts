/**
 * Takes whose tab died before they were stopped.
 *
 * The recorder writes every chunk to OPFS as it arrives, so a crash loses at
 * most the chunk in flight — but it never gets to write `meta.json`, and
 * without that the sync leaves the take alone (rightly: it cannot tell a dead
 * take from a live one) and nothing lists it. These files are the only copy
 * of whatever the user was recording. This finds them, and rebuilds the
 * metadata by probing the files, or throws them away when the user says so.
 *
 * What cannot be rebuilt, and is said plainly in the result: each track's
 * start offset (the tracks began within milliseconds of each other, so 0) and
 * any pauses (the files no longer contain the paused time, so the take simply
 * plays through).
 */

import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { recordingLockName } from "./session";
import { newId } from "./sources";
import {
  deleteLocalSession,
  getLocalTrackFile,
  listLocalSessionIds,
  localSessionFiles,
  truncateLocalFile,
  writeSessionMeta,
} from "./storage";
import { salvageLength } from "./webm-salvage";
import type { SessionMeta, SourceKind, TrackMeta } from "./types";

/** The names the recorder gives its files: `<kind>.<extension>`. */
const MEDIA_FILE = /^(screen|camera|microphone|system-audio)\.(webm|mp4|ogg)$/;

const LABEL: Record<SourceKind, string> = {
  screen: "Screen",
  camera: "Camera",
  microphone: "Microphone",
  "system-audio": "System audio",
};

export interface InterruptedTake {
  sessionId: string;
  files: { name: string; bytes: number }[];
  bytes: number;
  /** When the last chunk reached disk — roughly when the tab died. */
  lastModified: number;
  /** False when every file is empty; such a take can only be discarded. */
  recoverable: boolean;
}

async function liveLocks(): Promise<Set<string>> {
  if (typeof navigator === "undefined" || !navigator.locks?.query) return new Set();
  const state = await navigator.locks.query();
  return new Set([...(state.held ?? []), ...(state.pending ?? [])].map((lock) => lock.name ?? ""));
}

/** Newest first. Never includes a take that is still recording, in any tab. */
export async function findInterruptedTakes(): Promise<InterruptedTake[]> {
  const live = await liveLocks();
  const out: InterruptedTake[] = [];

  for (const sessionId of await listLocalSessionIds()) {
    if (live.has(recordingLockName(sessionId))) continue;
    const files = await localSessionFiles(sessionId);
    if (files.some((f) => f.name === "meta.json")) continue; // Finished: the sync's business.

    const media = files.filter((f) => MEDIA_FILE.test(f.name));
    if (media.every((f) => f.file.size === 0)) {
      // Nothing was ever written: a take aborted, or killed, before its first
      // chunk. Zero bytes cannot be lost, and offering to recover them would be
      // a prompt about nothing — so it is tidied quietly.
      await deleteLocalSession(sessionId).catch(() => undefined);
      continue;
    }
    out.push({
      sessionId,
      files: media.map((f) => ({ name: f.name, bytes: f.file.size })),
      bytes: media.reduce((n, f) => n + f.file.size, 0),
      lastModified: Math.max(...media.map((f) => f.file.lastModified)),
      recoverable: media.some((f) => f.file.size > 0),
    });
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

/** The file's own length: the end of its last readable packet, in ms. */
export async function probeDurationMs(file: Blob): Promise<number> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    return Math.round((await input.computeDuration()) * 1000);
  } finally {
    input.dispose();
  }
}

async function probeTrack(name: string, file: File): Promise<TrackMeta> {
  const kind = name.split(".")[0] as SourceKind;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) throw new Error("no readable track");
    // Read to the last complete packet: a crash usually cuts the final
    // cluster short, and what came before it is still good.
    const durationSec = await input.computeDuration();
    const mimeType = await input.getMimeType().catch(() => (video ? "video/webm" : "audio/webm"));
    return {
      id: newId(),
      kind,
      label: `${LABEL[kind]} (recovered)`,
      mimeType,
      fileName: name,
      bytes: file.size,
      offsetMs: 0,
      durationMs: Math.round(durationSec * 1000),
      pauses: [],
      ...(video ? { width: video.displayWidth, height: video.displayHeight } : {}),
      ...(audio && !video ? { sampleRate: audio.sampleRate, channelCount: audio.numberOfChannels } : {}),
    };
  } finally {
    input.dispose();
  }
}

/**
 * Writes the meta.json the recorder never got to write. After this the take
 * is an ordinary finished take: the next sync moves it to the server.
 */
export async function recoverTake(
  sessionId: string,
): Promise<{ meta: SessionMeta; unreadable: string[]; trimmed: { name: string; bytes: number }[] }> {
  const listed = (await localSessionFiles(sessionId)).filter((f) => MEDIA_FILE.test(f.name) && f.file.size > 0);
  if (listed.length === 0) throw new Error("Nothing in this take can be recovered — its files are empty.");

  // Cut each file back to its last complete block first. Without this the
  // demuxer drops the whole final cluster — up to tens of seconds of a still
  // screen — and so would every remux and export after it.
  const trimmed: { name: string; bytes: number }[] = [];
  const files: { name: string; file: File }[] = [];
  for (const { name, file } of listed) {
    const keep = name.endsWith(".webm") ? await salvageLength(file) : file.size;
    if (keep > 0 && keep < file.size) {
      await truncateLocalFile(sessionId, name, keep);
      trimmed.push({ name, bytes: file.size - keep });
      files.push({ name, file: await getLocalTrackFile(sessionId, name) });
    } else {
      files.push({ name, file });
    }
  }

  const tracks: TrackMeta[] = [];
  const unreadable: string[] = [];
  for (const { name, file } of files) {
    try {
      const track = await probeTrack(name, file);
      if (track.durationMs > 0) tracks.push(track);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  if (tracks.length === 0) throw new Error(`None of this take's files could be read (${unreadable.join(", ")}).`);

  const durationMs = Math.max(...tracks.map((t) => t.durationMs));
  const lastModified = Math.max(...files.map((f) => f.file.lastModified));
  const createdAt = Math.round(lastModified - durationMs);
  const meta: SessionMeta = {
    id: sessionId,
    name: `Recovered take · ${new Date(createdAt).toLocaleString()}`,
    createdAt,
    durationMs,
    tracks,
  };
  await writeSessionMeta(meta);
  return { meta, unreadable, trimmed };
}

/** Deletes the take's files from this browser. */
export async function discardTake(sessionId: string): Promise<void> {
  if ((await liveLocks()).has(recordingLockName(sessionId))) {
    throw new Error("That take is still being recorded.");
  }
  await deleteLocalSession(sessionId);
}
