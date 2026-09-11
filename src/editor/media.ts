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
 * Nothing here holds a whole file in memory. The remux runs on the server,
 * file to file. When it cannot, and for proxies (which need the browser's
 * encoder), output streams to the server a chunk at a time. Reads go through
 * URLs with byte ranges, and waveforms are computed from audio decoded a batch
 * at a time.
 */

import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Conversion,
  Input,
  Output,
  QUALITY_LOW,
  StreamTarget,
  UrlSource,
  WebMOutputFormat,
  type Source,
} from "mediabunny";
import type { SessionMeta } from "@/recorder/types";
import { api } from "@/lib/server";
import {
  mediaFileExists,
  mediaFileUrl,
  positionalUpload,
  remuxOnServer,
  sessionFileExists,
  sessionFileSize,
  sessionFileUrl,
  writeMediaFile,
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
/** Streamed output is sent in pieces of about this size. */
const UPLOAD_PIECE = 8 * 1024 * 1024;

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

type VideoOptions = NonNullable<Parameters<typeof Conversion.init>[0]["video"]>;

/**
 * Runs a conversion whose output streams to `uploadUrl` instead of piling up
 * in memory. A proper WebM, not an append-only one: the muxer goes back at the
 * end to write the duration and the seek index, and those writes are uploaded
 * at their positions like everything else — an append-only file would have
 * neither, which is the very defect the remux exists to fix.
 */
async function convertTo(
  input: MediaInput,
  uploadUrl: string,
  video?: VideoOptions,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const source = new Input({ source: sourceOf(input), formats: ALL_FORMATS });
  const upload = positionalUpload(uploadUrl);
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new StreamTarget(upload.writable, { chunked: true, chunkSize: UPLOAD_PIECE }),
  });
  try {
    const conversion = await Conversion.init({ input: source, output, ...(video ? { video } : {}) });
    if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);
    await conversion.execute();
    await upload.done;
  } finally {
    source.dispose();
  }
}

/**
 * A small VP8 transcode for playback.
 *
 * VP8 rather than VP9 on purpose: the proxy exists to be decoded quickly while
 * three other layers are being composited, and VP8 decodes faster than it
 * compresses well. Quality is deliberately low — nobody grades from a proxy.
 */
function makeProxy(input: MediaInput, uploadUrl: string, onProgress?: (fraction: number) => void): Promise<void> {
  return convertTo(
    input,
    uploadUrl,
    { height: PROXY_HEIGHT, fit: "contain", codec: "vp8", bitrate: QUALITY_LOW },
    onProgress,
  );
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
 * Min/max pairs per bucket, -1..1, the loudest of every channel.
 *
 * Decoded a sample batch at a time and folded straight into the buckets, so
 * memory stays flat however long the take is. The old way decoded the whole
 * file at once — about 115 MB of floats for an hour of audio before a single
 * peak could be drawn.
 */
export async function computePeaks(input: MediaInput, durationSec: number): Promise<number[] | undefined> {
  const source = new Input({ source: sourceOf(input), formats: ALL_FORMATS });
  try {
    const track = await source.getPrimaryAudioTrack();
    if (!track) return undefined;
    const buckets = Math.max(1, Math.round(durationSec * PEAKS_PER_SECOND));
    const mins = new Float32Array(buckets);
    const maxs = new Float32Array(buckets);
    let plane = new Float32Array(0);

    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        const frames = sample.numberOfFrames;
        if (plane.length < frames) plane = new Float32Array(frames);
        const perFrame = PEAKS_PER_SECOND / sample.sampleRate;
        const first = sample.timestamp * PEAKS_PER_SECOND;
        for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
          sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
          for (let i = 0; i < frames; i += 1) {
            const bucket = Math.floor(first + i * perFrame);
            if (bucket < 0 || bucket >= buckets) continue;
            const v = plane[i] ?? 0;
            if (v < (mins[bucket] ?? 0)) mins[bucket] = v;
            if (v > (maxs[bucket] ?? 0)) maxs[bucket] = v;
          }
        }
      } finally {
        sample.close();
      }
    }

    const peaks: number[] = [];
    for (let i = 0; i < buckets; i += 1) peaks.push(mins[i] ?? 0, maxs[i] ?? 0);
    return peaks;
  } catch {
    return undefined;
  } finally {
    source.dispose();
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
  /** Called for each track left out, with why. Without it they are only logged. */
  onSkip?: (fileName: string, reason: string) => void,
): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = [];
  const skipped: string[] = [];

  for (const [index, track] of session.tracks.entries()) {
    // One bad track — a microphone that was unplugged as the take began, a
    // file cut short — must not cost the user every other track of the take.
    try {
      assets.push(await importTrack(session, index, onProgress));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push(`${track.fileName}: ${reason}`);
      if (onSkip) onSkip(track.fileName, reason);
      else console.warn(`Skipped ${track.fileName}: ${reason}`);
    }
  }

  if (assets.length === 0) throw new Error(`None of this take's tracks could be imported (${skipped.join("; ")}).`);
  return assets;
}

async function importTrack(
  session: SessionMeta,
  index: number,
  onProgress?: (p: ImportProgress) => void,
): Promise<MediaAsset> {
  const track = session.tracks[index]!;
  const total = session.tracks.length;
  const editName = editableName(track.fileName);
  {
    if ((await sessionFileSize(session.id, track.fileName)) === 0) {
      throw new Error("the file is empty — nothing was recorded on this track");
    }

    if (!(await sessionFileExists(session.id, editName))) {
      onProgress?.({ name: track.fileName, index, total, stage: "remuxing" });
      // On the server when it can: file to file, off the page entirely. The
      // page is the fallback for a server that cannot, and it streams too.
      if (!(await remuxOnServer(session.id, track.fileName, editName))) {
        await convertTo(sessionFileUrl(session.id, track.fileName), sessionFileUrl(session.id, editName));
      }
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
        await makeProxy(editUrl, sessionFileUrl(session.id, proxy), (fraction) =>
          onProgress?.({ name: track.fileName, index, total, stage: "proxy", fraction }),
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

    return asset;
  }
}

/**
 * Imports arbitrary files the user dropped in or picked from disk. The file is
 * uploaded as-is — a disk-backed File, which the browser streams rather than
 * reading in; probing, thumbnails and the proxy all read the local copy, which
 * is already in hand and costs no round trip.
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
          await makeProxy(file, mediaFileUrl(proxyId), (fraction) =>
            onProgress?.({ name: file.name, index, total, stage: "proxy", fraction }),
          );
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
