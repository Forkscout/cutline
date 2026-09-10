/**
 * The export, moved off the main thread.
 *
 * Compositing and encoding a long timeline is minutes of continuous work. Run
 * inline it freezes the interface completely — the progress bar cannot repaint,
 * Cancel cannot be clicked, and the browser may offer to kill the tab. None of
 * that is a rendering problem; it is simply the wrong thread.
 *
 * The audio mix stays on the main thread and arrives here as raw samples,
 * because `OfflineAudioContext` is not exposed to workers and reimplementing
 * gain ramps and resampling by hand would be a worse trade than one transfer.
 */

/// <reference lib="webworker" />

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  VideoSampleSink,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type Quality,
  type VideoSample,
} from "mediabunny";
import { getMediaFile, getTrackFile } from "@/recorder/storage";
import { assetTimeFor, drawFrame, makeCanvas } from "./compositor";
import type { MediaAsset, Project } from "./types";

export interface WorkerOptions {
  container: "mp4" | "webm";
  width: number;
  height: number;
  frameRate: number;
  quality: "low" | "medium" | "high" | "veryHigh";
  bitrateMbps: number | null;
  from: number;
  to: number;
}

/** Planar float32, one channel after another — what an AudioBuffer already is. */
export interface WorkerAudio {
  data: Float32Array;
  channels: number;
  sampleRate: number;
}

export type ToWorker =
  | { type: "run"; project: Project; options: WorkerOptions; audio: WorkerAudio | null }
  | { type: "cancel" };

export type FromWorker =
  | { type: "progress"; stage: "video" | "finalising"; progress: number; frame: number; totalFrames: number }
  | { type: "done"; buffer: ArrayBuffer; mimeType: string }
  | { type: "error"; message: string };

const QUALITIES: Record<WorkerOptions["quality"], Quality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  veryHigh: QUALITY_VERY_HIGH,
};

/** One second of audio per sample: small enough to stay responsive, large
 *  enough that the per-sample overhead disappears. */
const AUDIO_CHUNK_SEC = 1;

let cancelled = false;

function post(message: FromWorker, transfer: Transferable[] = []) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

/**
 * The export always reads the original, never the proxy — a file delivered from
 * a 720p playback copy would be exactly the right length and visibly soft.
 */
async function originalFile(asset: MediaAsset): Promise<File> {
  if (asset.origin.type === "recording") {
    return getTrackFile(asset.origin.sessionId, asset.origin.fileName);
  }
  return getMediaFile(asset.id);
}

/**
 * A clip's decoded frames, pulled one per output frame.
 *
 * Export walks time forwards, so each clip's needed timestamps are monotonic —
 * which lets mediabunny decode each packet once instead of seeking per frame.
 */
class ClipFrames {
  private iterator: AsyncGenerator<VideoSample | null, void, unknown>;
  private last: VideoSample | null = null;

  constructor(sink: VideoSampleSink, timestamps: number[]) {
    this.iterator = sink.samplesAtTimestamps(timestamps);
  }

  async next(): Promise<VideoSample | null> {
    const result = await this.iterator.next();
    if (result.done) return this.last;
    // A null means no new frame for this timestamp — hold the previous one
    // rather than dropping to black between source frames.
    if (result.value) {
      this.last?.close();
      this.last = result.value;
    }
    return this.last;
  }

  close(): void {
    this.last?.close();
    this.last = null;
    void this.iterator.return(undefined);
  }
}

async function run(project: Project, options: WorkerOptions, audio: WorkerAudio | null) {
  const { width, height, frameRate: fps, from, to } = options;
  const duration = to - from;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const scaled: Project = { ...project, width, height };

  const videoCodec = await getFirstEncodableVideoCodec(
    options.container === "mp4" ? ["avc", "hevc", "av1"] : ["vp9", "vp8", "av1"],
    { width, height },
  );
  if (!videoCodec) throw new Error("This browser cannot encode video in that container.");

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false }) as
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("Could not get a 2D context for the export.");

  const output = new Output({
    format: options.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    ...(options.bitrateMbps
      ? { bitrate: Math.round(options.bitrateMbps * 1_000_000) }
      : { quality: QUALITIES[options.quality] }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioSource: AudioSampleSource | null = null;
  const audioCodec = audio
    ? await getFirstEncodableAudioCodec(options.container === "mp4" ? ["aac", "opus"] : ["opus"])
    : null;
  if (audio && audioCodec) {
    audioSource = new AudioSampleSource({ codec: audioCodec, quality: QUALITY_HIGH });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const inputs: Input[] = [];
  const frames = new Map<string, ClipFrames>();
  const stills = new Map<string, ImageBitmap>();

  try {
    if (audio && audioSource) {
      const perChannel = audio.data.length / audio.channels;
      const chunk = Math.floor(audio.sampleRate * AUDIO_CHUNK_SEC);
      for (let offset = 0; offset < perChannel; offset += chunk) {
        const length = Math.min(chunk, perChannel - offset);
        // Rebuilt planar: the encoder wants each channel contiguous, and the
        // incoming buffer is one long run of them.
        const slice = new Float32Array(length * audio.channels);
        for (let c = 0; c < audio.channels; c += 1) {
          slice.set(
            audio.data.subarray(c * perChannel + offset, c * perChannel + offset + length),
            c * length,
          );
        }
        const sample = new AudioSample({
          data: slice,
          format: "f32-planar",
          numberOfChannels: audio.channels,
          sampleRate: audio.sampleRate,
          timestamp: offset / audio.sampleRate,
        });
        await audioSource.add(sample);
        // Each sample holds decoded audio outside the JS heap. Leaving them to
        // the garbage collector leaks for the length of the export, and
        // mediabunny says so on the console every time.
        sample.close();
      }
    }

    for (const track of scaled.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        const asset = scaled.assets.find((a) => a.id === clip.assetId);
        if (!asset?.hasVideo || asset.offline) continue;

        const file = await originalFile(asset);

        if (asset.kind === "image") {
          // A still needs decoding exactly once, not per frame.
          stills.set(clip.id, await createImageBitmap(file));
          continue;
        }

        const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
        inputs.push(input);
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) continue;

        const timestamps: number[] = [];
        for (let i = 0; i < totalFrames; i += 1) {
          const t = from + i / fps;
          if (t >= clip.start && t < clip.start + clip.duration) {
            timestamps.push(Math.max(0, assetTimeFor(clip, t)));
          }
        }
        frames.set(clip.id, new ClipFrames(new VideoSampleSink(videoTrack), timestamps));
      }
    }

    const pending = new Map<string, CanvasImageSource | null>();

    for (let i = 0; i < totalFrames; i += 1) {
      if (cancelled) throw new DOMException("Export cancelled", "AbortError");
      const t = from + i / fps;

      pending.clear();
      for (const track of scaled.tracks) {
        if (track.kind !== "video" || track.hidden) continue;
        for (const clip of track.clips) {
          if (!clip.enabled) continue;
          if (t < clip.start || t >= clip.start + clip.duration) continue;

          const still = stills.get(clip.id);
          if (still) {
            pending.set(clip.id, still);
            continue;
          }
          const source = frames.get(clip.id);
          if (!source) continue;
          const sample = await source.next();
          pending.set(clip.id, sample ? sample.toCanvasImageSource() : null);
        }
      }

      // Guides are a preview aid and must never reach the file.
      drawFrame(
        ctx as unknown as CanvasRenderingContext2D,
        scaled,
        t,
        (clip) => pending.get(clip.id) ?? null,
        { guides: false },
      );
      await videoSource.add(i / fps, 1 / fps);

      if (i % 5 === 0 || i === totalFrames - 1) {
        post({
          type: "progress",
          stage: "video",
          progress: (i + 1) / totalFrames,
          frame: i + 1,
          totalFrames,
        });
      }
    }

    post({ type: "progress", stage: "finalising", progress: 1, frame: totalFrames, totalFrames });
    await output.finalize();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Export produced no data.");
    post(
      {
        type: "done",
        buffer,
        mimeType: options.container === "mp4" ? "video/mp4" : "video/webm",
      },
      [buffer],
    );
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    for (const source of frames.values()) source.close();
    for (const bitmap of stills.values()) bitmap.close();
    for (const input of inputs) input.dispose();
  }
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled = true;
    return;
  }
  cancelled = false;
  try {
    await run(message.project, message.options, message.audio);
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
