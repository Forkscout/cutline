/**
 * Getting media into a state the editor can actually work with.
 *
 * The files the recorder writes are valid WebM but have no Duration and no
 * Cues — MediaRecorder cannot go back and write them once the take ends. A
 * `<video>` fed one of those reports an infinite duration and seeks by
 * guessing, which in an editor shows up as a scrubber that lands on the wrong
 * frame. So every recording is remuxed once on import: a copy, not a
 * re-encode — the same packets, written into a container that has an index.
 *
 * Everything imported lives on the local server. Reads go through URLs with
 * byte ranges — mediabunny's `UrlSource` for decoding, plain `src` attributes
 * for playback — so a multi-gigabyte recording is read a window at a time
 * rather than pulled into memory whole.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  QUALITY_LOW,
  UrlSource,
  WebMOutputFormat,
  type Source,
} from "mediabunny";
import type { SessionMeta } from "@/recorder/types";
import { api } from "@/lib/server";
import {
  mediaFileExists,
  mediaFileUrl,
  sessionFileExists,
  sessionFileSize,
  sessionFileUrl,
  writeMediaFile,
  writeSessionFile,
} from "@/lib/media-store";
import type { AssetKind, MediaAsset } from "./types";

/** The remuxed sibling of a recorded file. */
export function editableName(fileName: string): string {
  return fileName.replace(/\.(\w+)$/, ".edit.$1");
}

/** The playback-resolution sibling. */
export function proxyName(fileName: string): string {
  return fileName.replace(/\.(\w+)$/, ".proxy.webm");
}

/** Anything taller than this gets a proxy; below it the original plays fine. */
const PROXY_TRIGGER_HEIGHT = 1200;
/** What the proxy is scaled to. */
const PROXY_HEIGHT = 720;

/** A fresh drop from the user's disk, or a URL for anything already on the server. */
type MediaInput = File | string;

function sourceOf(input: MediaInput): Source {
  return typeof input === "string" ? new UrlSource(input) : new BlobSource(input);
}

async function blobOf(input: MediaInput): Promise<Blob> {
  if (typeof input !== "string") return input;
  const response = await api(input);
  if (!response.ok) throw new Error(`Could not read ${input} (${response.status}).`);
  return response.blob();
}

/**
 * A small VP8 transcode for playback.
 *
 * VP8 rather than VP9 on purpose: the proxy exists to be decoded quickly while
 * three other layers are being composited, and VP8 decodes faster than it
 * compresses well. Quality is deliberately low — nobody grades from a proxy.
 */
async function makeProxy(input: MediaInput, onProgress?: (fraction: number) => void): Promise<ArrayBuffer> {
  const source = new Input({ source: sourceOf(input), formats: ALL_FORMATS });
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  try {
    const conversion = await Conversion.init({
      input: source,
      output,
      video: { height: PROXY_HEIGHT, fit: "contain", codec: "vp8", bitrate: QUALITY_LOW },
    });
    if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Proxy produced no output.");
    return buffer;
  } finally {
    source.dispose();
  }
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

async function probeMedia(input: MediaInput): Promise<Probe> {
  const source = new Input({ source: sourceOf(input), formats: ALL_FORMATS });
  try {
    const durationSec = await source.computeDuration();
    const video = (await source.getVideoTracks())[0];
    const audio = (await source.getAudioTracks())[0];
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
    // Leaving the input open holds its cache and its decoder alive.
    source.dispose();
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

/**
 * Remuxes into memory. For a long take that is a lot of memory — a streaming
 * upload would avoid it, but Chrome only streams request bodies over HTTP/2,
 * and the dev proxy speaks HTTP/1.1. Moving the remux to the server, which can
 * write file to file, is the real fix and is on the roadmap.
 */
async function remux(input: MediaInput): Promise<ArrayBuffer> {
  const source = new Input({ source: sourceOf(input), formats: ALL_FORMATS });
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  try {
    const conversion = await Conversion.init({ input: source, output });
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Remux produced no output.");
    return buffer;
  } finally {
    source.dispose();
  }
}

/* -------------------------------------------------------------- thumbnails */

const THUMB_WIDTH = 240;

async function thumbnailFor(input: MediaInput, kind: AssetKind): Promise<string | undefined> {
  try {
    if (kind === "audio") return undefined;
    const bitmap =
      kind === "image" ? await createImageBitmap(await blobOf(input)) : await firstFrameBitmap(input);
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

async function firstFrameBitmap(input: MediaInput): Promise<ImageBitmap | null> {
  const { VideoSampleSink } = await import("mediabunny");
  const source = new Input({ source: sourceOf(input), formats: ALL_FORMATS });
  try {
    const track = await source.getPrimaryVideoTrack();
    if (!track) return null;
    const sink = new VideoSampleSink(track);
    // A frame slightly in, not the very first: the opening frame of a screen
    // recording is often the desktop before anything has been drawn.
    const sample = (await sink.getSample(0.4)) ?? (await sink.getSample(0));
    if (!sample) return null;
    const image = sample.toCanvasImageSource();
    const bitmap = await createImageBitmap(image as CanvasImageSource);
    sample.close();
    return bitmap;
  } catch {
    return null;
  } finally {
    source.dispose();
  }
}

/* ---------------------------------------------------------------- waveform */

/** Buckets per second of audio. Enough to read a sentence's shape at a glance. */
export const PEAKS_PER_SECOND = 40;

/**
 * Min/max pairs per bucket, normalised to 0..1.
 *
 * Decoded at 8 kHz mono rather than the file's real rate: a waveform is a
 * picture of loudness, and decoding a ten-minute take at 48 kHz stereo to draw
 * a 200-pixel-wide strip wastes about forty times the memory it needs.
 */
export async function computePeaks(input: MediaInput, durationSec: number): Promise<number[] | undefined> {
  try {
    const sampleRate = 8000;
    const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(durationSec * sampleRate)), sampleRate);
    // decodeAudioData genuinely needs every byte, so this is the one read that
    // is whole. Audio is small next to video — minutes of Opus, not gigabytes.
    const buffer = await context.decodeAudioData(await (await blobOf(input)).arrayBuffer());
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
  stage: "remuxing" | "probing" | "thumbnail" | "waveform" | "proxy";
  /** 0..1 within the current stage, where the stage can report it. */
  fraction?: number;
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

/**
 * Imports every track of a recording session, remuxing any not seen before.
 * The session must already be on the server — `syncLocalRecordings` puts it
 * there.
 */
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
      await writeSessionFile(session.id, editName, await remux(sessionFileUrl(session.id, track.fileName)));
    }

    onProgress?.({ name: track.fileName, index, total, stage: "probing" });
    const editUrl = sessionFileUrl(session.id, editName);
    const info = await probeMedia(editUrl);
    const kind: AssetKind = info.hasVideo ? "video" : "audio";

    const asset: MediaAsset = {
      ...baseAsset(track.label || track.kind, kind, track.mimeType, (await sessionFileSize(session.id, editName)) ?? 0),
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

    if (info.hasVideo && info.height > PROXY_TRIGGER_HEIGHT) {
      const proxy = proxyName(track.fileName);
      if (!(await sessionFileExists(session.id, proxy))) {
        onProgress?.({ name: track.fileName, index, total, stage: "proxy", fraction: 0 });
        await writeSessionFile(
          session.id,
          proxy,
          await makeProxy(editUrl, (fraction) =>
            onProgress?.({ name: track.fileName, index, total, stage: "proxy", fraction }),
          ),
        );
      }
      asset.proxyName = proxy;
    }

    onProgress?.({ name: track.fileName, index, total, stage: "thumbnail" });
    asset.thumbnail = await thumbnailFor(editUrl, kind);
    if (info.hasAudio) {
      onProgress?.({ name: track.fileName, index, total, stage: "waveform" });
      asset.peaks = await computePeaks(editUrl, asset.durationSec);
    }

    assets.push(asset);
  }

  return assets;
}

/**
 * Imports arbitrary files the user dropped in or picked from disk. The file is
 * uploaded as-is; probing, thumbnails and the proxy all read the local copy,
 * which is already in hand and costs no round trip.
 */
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

      if (info.hasVideo && info.height > PROXY_TRIGGER_HEIGHT) {
        const proxyId = `${fileId}.proxy`;
        if (!(await mediaFileExists(proxyId))) {
          onProgress?.({ name: file.name, index, total, stage: "proxy", fraction: 0 });
          const bytes = await makeProxy(file, (fraction) =>
            onProgress?.({ name: file.name, index, total, stage: "proxy", fraction }),
          );
          await writeMediaFile(proxyId, new Blob([bytes], { type: "video/webm" }));
        }
        asset.proxyName = proxyId;
      }

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

function originalUrl(asset: MediaAsset): string {
  return asset.origin.type === "recording"
    ? sessionFileUrl(asset.origin.sessionId, asset.origin.fileName)
    : mediaFileUrl(asset.id);
}

function proxyUrl(asset: MediaAsset): string | null {
  if (!asset.proxyName) return null;
  return asset.origin.type === "recording"
    ? sessionFileUrl(asset.origin.sessionId, asset.proxyName)
    : mediaFileUrl(asset.proxyName);
}

/**
 * Where an asset can be read from. `preferProxy` is for playback only — the
 * exporter must never pass it, because a file delivered from a 720p proxy would
 * be exactly as long, exactly the right codec, and visibly soft.
 */
export function assetUrl(asset: MediaAsset, preferProxy = false): string {
  return (preferProxy ? proxyUrl(asset) : null) ?? originalUrl(asset);
}

/**
 * The whole file, in memory. Only for callers that need every byte — the
 * export's audio mix, which hands it to `decodeAudioData`. Everything else
 * reads through `assetUrl`.
 */
export async function assetFile(asset: MediaAsset, preferProxy = false): Promise<File> {
  const proxy = preferProxy ? proxyUrl(asset) : null;
  if (proxy) {
    try {
      const blob = await blobOf(proxy);
      return new File([blob], asset.name, { type: blob.type });
    } catch {
      // A missing proxy is a performance problem, not a failure.
    }
  }
  const blob = await blobOf(originalUrl(asset));
  return new File([blob], asset.name, { type: blob.type });
}

/** Whether the asset's original is still on the server, without reading it. */
export async function assetExists(asset: MediaAsset): Promise<boolean> {
  return (await api(originalUrl(asset), { method: "HEAD" })).ok;
}

/** True when this asset is being played from a reduced-resolution copy. */
export function usingProxy(asset: MediaAsset): boolean {
  return Boolean(asset.proxyName);
}

/**
 * Playback URLs for assets, resolved once and reused.
 *
 * These are server URLs, not blob URLs: the element streams with range
 * requests instead of the whole file being read into a Blob first, which for a
 * long recording was the difference between opening instantly and not opening.
 * The one lookup that is worth caching is whether a proxy actually exists.
 */
export class AssetUrls {
  private urls = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();

  async get(asset: MediaAsset): Promise<string> {
    const existing = this.urls.get(asset.id);
    if (existing) return existing;
    // Two clips of the same asset resolve at once on load.
    const inFlight = this.pending.get(asset.id);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const proxy = proxyUrl(asset);
      if (proxy) {
        // A proxy that was never generated, or has gone missing, falls back to
        // the original — a performance problem, not a failure.
        const head = await api(proxy, { method: "HEAD" }).catch(() => null);
        if (head?.ok) return proxy;
      }
      return originalUrl(asset);
    })().then((url) => {
      this.urls.set(asset.id, url);
      this.pending.delete(asset.id);
      return url;
    });
    this.pending.set(asset.id, promise);
    return promise;
  }

  /** Nothing to revoke — these are server URLs, not object URLs. */
  dispose(): void {
    this.urls.clear();
    this.pending.clear();
  }
}
