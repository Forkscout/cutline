/**
 * Getting media into a state the editor can actually work with.
 *
 * The files the recorder writes are valid WebM but have no Duration and no
 * Cues — MediaRecorder cannot go back and write them once the take ends. A
 * `<video>` fed one of those reports an infinite duration and seeks by
 * guessing, which in an editor shows up as a scrubber that lands on the wrong
 * frame. So every recording is remuxed once on import: a copy, not a
 * re-encode — the same packets, written into a container that has an index.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import type { SessionMeta } from "@/recorder/types";
import {
  getMediaFile,
  getTrackFile,
  sessionFileExists,
  writeMediaFile,
  writeSessionFile,
} from "@/recorder/storage";
import type { AssetKind, MediaAsset } from "./types";

/** The remuxed sibling of a recorded file. */
export function editableName(fileName: string): string {
  return fileName.replace(/\.(\w+)$/, ".edit.$1");
}

const IMAGE_TYPES = /^image\//;
const AUDIO_TYPES = /^audio\//;

function kindFor(file: { type: string; name: string }): AssetKind {
  if (IMAGE_TYPES.test(file.type)) return "image";
  if (AUDIO_TYPES.test(file.type)) return "audio";
  if (/\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(file.name)) return "image";
  if (/\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i.test(file.name)) return "audio";
  return "video";
}

interface Probe {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  sampleRate?: number;
  channels?: number;
}

async function probeMedia(file: File): Promise<Probe> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const durationSec = await input.computeDuration();
    const video = (await input.getVideoTracks())[0];
    const audio = (await input.getAudioTracks())[0];
    let frameRate = 30;
    if (video) {
      const stats = await video.computePacketStats(120);
      if (stats.averagePacketRate > 0) frameRate = stats.averagePacketRate;
    }
    return {
      durationSec,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      width: video?.displayWidth ?? 0,
      height: video?.displayHeight ?? 0,
      frameRate,
      ...(audio ? { sampleRate: audio.sampleRate, channels: audio.numberOfChannels } : {}),
    };
  } finally {
    // Leaving the input open holds the whole blob and its decoder alive.
    input.dispose();
  }
}

async function probeImage(file: File): Promise<Probe> {
  const bitmap = await createImageBitmap(file);
  const probe: Probe = {
    // Stills have no length of their own, so they get a sensible default the
    // user can trim; five seconds is the convention every editor uses.
    durationSec: 5,
    hasVideo: true,
    hasAudio: false,
    width: bitmap.width,
    height: bitmap.height,
    frameRate: 30,
  };
  bitmap.close();
  return probe;
}

async function remux(file: File): Promise<ArrayBuffer> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const conversion = await Conversion.init({ input, output });
  await conversion.execute();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("Remux produced no output.");
  return buffer;
}

/* -------------------------------------------------------------- thumbnails */

const THUMB_WIDTH = 240;

async function thumbnailFor(file: File, kind: AssetKind): Promise<string | undefined> {
  try {
    if (kind === "audio") return undefined;
    const bitmap =
      kind === "image"
        ? await createImageBitmap(file)
        : await firstFrameBitmap(file);
    if (!bitmap) return undefined;

    const scale = THUMB_WIDTH / bitmap.width;
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  }
}

async function firstFrameBitmap(file: File): Promise<ImageBitmap | null> {
  const { VideoSampleSink } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const sink = new VideoSampleSink(track);
    // A frame slightly in, not the very first: the opening frame of a screen
    // recording is often the desktop before anything has been drawn.
    const sample = (await sink.getSample(0.4)) ?? (await sink.getSample(0));
    if (!sample) return null;
    const source = sample.toCanvasImageSource();
    const bitmap = await createImageBitmap(source as CanvasImageSource);
    sample.close();
    return bitmap;
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

/* ---------------------------------------------------------------- waveform */

/** Buckets per second of audio. Enough to read a sentence's shape at a glance. */
const PEAKS_PER_SECOND = 40;

/**
 * Min/max pairs per bucket, normalised to 0..1.
 *
 * Decoded at 8 kHz mono rather than the file's real rate: a waveform is a
 * picture of loudness, and decoding a ten-minute take at 48 kHz stereo to draw
 * a 200-pixel-wide strip wastes about forty times the memory it needs.
 */
export async function computePeaks(file: File, durationSec: number): Promise<number[] | undefined> {
  try {
    const sampleRate = 8000;
    const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(durationSec * sampleRate)), sampleRate);
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const data = buffer.getChannelData(0);
    const buckets = Math.max(1, Math.round(durationSec * PEAKS_PER_SECOND));
    const perBucket = Math.max(1, Math.floor(data.length / buckets));
    const peaks: number[] = [];
    for (let i = 0; i < buckets; i += 1) {
      let min = 0;
      let max = 0;
      const from = i * perBucket;
      const to = Math.min(data.length, from + perBucket);
      for (let j = from; j < to; j += 1) {
        const v = data[j] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks.push(min, max);
    }
    return peaks;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ import */

export interface ImportProgress {
  name: string;
  index: number;
  total: number;
  stage: "remuxing" | "probing" | "thumbnail" | "waveform";
}

function baseAsset(name: string, kind: AssetKind, mimeType: string, bytes: number): MediaAsset {
  return {
    id: crypto.randomUUID(),
    origin: { type: "file" },
    name,
    kind,
    mimeType,
    bytes,
    durationSec: 0,
    hasVideo: false,
    hasAudio: false,
    width: 0,
    height: 0,
    frameRate: 30,
    createdAt: Date.now(),
    binId: null,
    tags: [],
    rating: 0,
    colorLabel: null,
    favorite: false,
  };
}

/** Imports every track of a recording session, remuxing any not seen before. */
export async function importSession(
  session: SessionMeta,
  onProgress?: (p: ImportProgress) => void,
): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = [];

  for (const [index, track] of session.tracks.entries()) {
    const total = session.tracks.length;
    const editName = editableName(track.fileName);

    if (!(await sessionFileExists(session.id, editName))) {
      onProgress?.({ name: track.fileName, index, total, stage: "remuxing" });
      const original = await getTrackFile(session.id, track.fileName);
      await writeSessionFile(session.id, editName, await remux(original));
    }

    onProgress?.({ name: track.fileName, index, total, stage: "probing" });
    const editable = await getTrackFile(session.id, editName);
    const info = await probeMedia(editable);
    const kind: AssetKind = info.hasVideo ? "video" : "audio";

    const asset: MediaAsset = {
      ...baseAsset(track.label || track.kind, kind, track.mimeType, editable.size),
      id: track.id,
      origin: { type: "recording", sessionId: session.id, fileName: editName },
      sourceKind: track.kind,
      createdAt: session.createdAt,
      // The recorder's own measurement and the remuxed file should agree; if
      // they do not, the file is the thing that will actually be decoded.
      durationSec: info.durationSec || track.durationMs / 1000,
      hasVideo: info.hasVideo,
      hasAudio: info.hasAudio,
      width: info.width || (track.width ?? 0),
      height: info.height || (track.height ?? 0),
      frameRate: info.frameRate,
      ...(info.sampleRate ? { sampleRate: info.sampleRate } : {}),
      ...(info.channels ? { channels: info.channels } : {}),
    };

    onProgress?.({ name: track.fileName, index, total, stage: "thumbnail" });
    asset.thumbnail = await thumbnailFor(editable, kind);
    if (info.hasAudio) {
      onProgress?.({ name: track.fileName, index, total, stage: "waveform" });
      asset.peaks = await computePeaks(editable, asset.durationSec);
    }

    assets.push(asset);
  }

  return assets;
}

/** Imports arbitrary files the user dropped in or picked from disk. */
export async function importFiles(
  files: File[],
  onProgress?: (p: ImportProgress) => void,
): Promise<{ assets: MediaAsset[]; failed: { name: string; reason: string }[] }> {
  const assets: MediaAsset[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const [index, file] of files.entries()) {
    const total = files.length;
    const kind = kindFor(file);
    try {
      onProgress?.({ name: file.name, index, total, stage: "probing" });
      const info = kind === "image" ? await probeImage(file) : await probeMedia(file);

      const fileId = crypto.randomUUID();
      await writeMediaFile(fileId, file);

      const asset: MediaAsset = {
        ...baseAsset(file.name, kind, file.type || "application/octet-stream", file.size),
        id: fileId,
        origin: { type: "file" },
        durationSec: info.durationSec,
        hasVideo: info.hasVideo,
        hasAudio: info.hasAudio,
        width: info.width,
        height: info.height,
        frameRate: info.frameRate,
        createdAt: file.lastModified || Date.now(),
        ...(info.sampleRate ? { sampleRate: info.sampleRate } : {}),
        ...(info.channels ? { channels: info.channels } : {}),
      };

      onProgress?.({ name: file.name, index, total, stage: "thumbnail" });
      asset.thumbnail = await thumbnailFor(file, kind);
      if (info.hasAudio) {
        onProgress?.({ name: file.name, index, total, stage: "waveform" });
        asset.peaks = await computePeaks(file, info.durationSec);
      }

      assets.push(asset);
    } catch (err) {
      // One unreadable file must not abandon the rest of a batch import.
      failed.push({
        name: file.name,
        reason: err instanceof Error ? err.message : "Unsupported or unreadable file.",
      });
    }
  }

  return { assets, failed };
}

/* ------------------------------------------------------------------ access */

/** Reads an asset's bytes back, wherever they live. */
export async function assetFile(asset: MediaAsset): Promise<File> {
  if (asset.origin.type === "recording") {
    return getTrackFile(asset.origin.sessionId, asset.origin.fileName);
  }
  return getMediaFile(asset.id);
}

/**
 * Object URLs for assets, created once and reused. Every `<video>` in the
 * preview points at these, so creating them per render would leak a blob
 * handle per frame.
 */
export class AssetUrls {
  private urls = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();

  async get(asset: MediaAsset): Promise<string> {
    const existing = this.urls.get(asset.id);
    if (existing) return existing;
    // Two clips of the same asset resolve at once on load; without this they
    // would each create a URL and one would leak.
    const inFlight = this.pending.get(asset.id);
    if (inFlight) return inFlight;

    const promise = assetFile(asset).then((file) => {
      const url = URL.createObjectURL(file);
      this.urls.set(asset.id, url);
      this.pending.delete(asset.id);
      return url;
    });
    this.pending.set(asset.id, promise);
    return promise;
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pending.clear();
  }
}
