/**
 * Export: decode, composite, encode — all in the browser, on the GPU wherever
 * the browser allows it.
 *
 * The property that matters here is that the picture is produced by the same
 * `drawFrame` the preview uses. The exporter only changes where the frames come
 * from: mediabunny decodes them at exact timestamps instead of a `<video>`
 * approximating them. So an export cannot silently disagree with the preview
 * about layout, colour, effects or order.
 */

import {
  ALL_FORMATS,
  AudioBufferSource,
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
import { assetTimeFor, drawFrame } from "./compositor";
import { assetFile } from "./media";
import { assetOf, fadeGainAt, projectDuration, trackAudible } from "./project";
import type { Container } from "./presets";
import type { Clip, Project } from "./types";

export interface ExportOptions {
  container: Container;
  /** Output height; width follows the project's aspect ratio. */
  height: number;
  frameRate: number;
  quality: "low" | "medium" | "high" | "veryHigh";
  /** Megabits per second. When null, the quality level decides. */
  bitrateMbps: number | null;
  /** Render only between the project's in and out points. */
  useInOut: boolean;
}

export interface ExportProgress {
  stage: "audio" | "video" | "finalising";
  /** 0..1 within the whole export. */
  progress: number;
  frame: number;
  totalFrames: number;
}

const QUALITIES: Record<ExportOptions["quality"], Quality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  veryHigh: QUALITY_VERY_HIGH,
};

/* ------------------------------------------------------------------ audio */

/** Reverses a buffer in place-ish, returning a new one. Used by reversed clips. */
function reverseBuffer(context: OfflineAudioContext, buffer: AudioBuffer): AudioBuffer {
  const out = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const source = buffer.getChannelData(c);
    const target = out.getChannelData(c);
    for (let i = 0; i < source.length; i += 1) target[i] = source[source.length - 1 - i] ?? 0;
  }
  return out;
}

/**
 * Mixes every audible clip down to one buffer with an OfflineAudioContext.
 *
 * Doing the mix offline rather than clip-by-clip at encode time means gain,
 * fades, pan and placement are handled by the same engine the browser uses for
 * playback — so the export sounds like the preview — and overlapping clips sum
 * instead of one winning.
 */
async function mixAudio(
  project: Project,
  from: number,
  to: number,
): Promise<AudioBuffer | null> {
  const sampleRate = 48000;
  const duration = to - from;
  interface Voice {
    clip: Clip;
    assetId: string;
  }
  const voices: Voice[] = [];

  for (const track of project.tracks) {
    if (!trackAudible(project, track)) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.muted || clip.volume <= 0) continue;
      const asset = assetOf(project, clip);
      if (!asset?.hasAudio || asset.offline) continue;
      if (clip.start + clip.duration <= from || clip.start >= to) continue;
      voices.push({ clip, assetId: asset.id });
    }
  }
  if (voices.length === 0) return null;

  const context = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const decoded = new Map<string, AudioBuffer>();

  for (const { clip } of voices) {
    const asset = assetOf(project, clip);
    if (!asset) continue;

    let buffer = decoded.get(asset.id);
    if (!buffer) {
      const file = await assetFile(asset);
      buffer = await context.decodeAudioData(await file.arrayBuffer());
      decoded.set(asset.id, buffer);
    }

    const node = context.createBufferSource();
    node.buffer = clip.reversed ? reverseBuffer(context, buffer) : buffer;
    node.playbackRate.value = Math.max(0.05, clip.speed);

    const gain = context.createGain();
    const pan = context.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, clip.pan));
    node.connect(gain).connect(pan).connect(context.destination);

    // Fades are scheduled as ramps rather than baked into the buffer, so the
    // curve matches what the preview's GainNode did.
    const startAt = Math.max(0, clip.start - from);
    const endAt = Math.min(duration, clip.start + clip.duration - from);
    gain.gain.setValueAtTime(clip.fadeIn > 0 ? 0 : clip.volume, startAt);
    if (clip.fadeIn > 0) {
      gain.gain.linearRampToValueAtTime(clip.volume, startAt + Math.min(clip.fadeIn, endAt - startAt));
    }
    if (clip.fadeOut > 0) {
      const fadeStart = Math.max(startAt, endAt - clip.fadeOut);
      gain.gain.setValueAtTime(clip.volume * fadeGainAt(clip, from + fadeStart), fadeStart);
      gain.gain.linearRampToValueAtTime(0, endAt);
    }

    const offset = clip.inPoint;
    const length = Math.min(clip.duration, endAt - startAt);
    if (length > 0) node.start(startAt, Math.max(0, offset), length * clip.speed);
  }

  return context.startRendering();
}

/* ------------------------------------------------------------------ video */

/**
 * A clip's decoded frames, pulled one per output frame.
 *
 * Export walks time forwards, so each clip's needed timestamps are monotonic —
 * which lets mediabunny decode each packet once instead of seeking per frame.
 * The difference between this and calling `getSample` per frame is roughly an
 * order of magnitude.
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

export async function exportProject(
  project: Project,
  options: ExportOptions,
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const end = projectDuration(project);
  const from = options.useInOut ? (project.inPoint ?? 0) : 0;
  const to = options.useInOut ? (project.outPoint ?? end) : end;
  const duration = to - from;
  if (duration <= 0) throw new Error("There is nothing on the timeline to export.");

  // Encoders reject odd dimensions; round both down to an even number.
  const scale = options.height / project.height;
  const width = Math.round((project.width * scale) / 2) * 2;
  const height = Math.round(options.height / 2) * 2;
  const fps = options.frameRate;
  const totalFrames = Math.max(1, Math.round(duration * fps));

  const scaled: Project = { ...project, width, height };

  const videoCodec = await getFirstEncodableVideoCodec(
    options.container === "mp4" ? ["avc", "hevc", "av1"] : ["vp9", "vp8", "av1"],
    { width, height },
  );
  if (!videoCodec) throw new Error("This browser cannot encode video in that container.");

  const audioCodec = await getFirstEncodableAudioCodec(
    options.container === "mp4" ? ["aac", "opus"] : ["opus"],
  );

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
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

  onProgress?.({ stage: "audio", progress: 0, frame: 0, totalFrames });
  const mixed = audioCodec ? await mixAudio(scaled, from, to) : null;
  let audioSource: AudioBufferSource | null = null;
  if (mixed && audioCodec) {
    audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const inputs: Input[] = [];
  const frames = new Map<string, ClipFrames>();
  const stills = new Map<string, ImageBitmap>();

  try {
    if (audioSource && mixed) await audioSource.add(mixed);

    for (const track of scaled.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        const asset = assetOf(scaled, clip);
        if (!asset?.hasVideo || asset.offline) continue;

        const file = await assetFile(asset);

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
        // A reversed clip walks its source backwards, and the decoder needs the
        // timestamps in the order it will be asked for them.
        frames.set(clip.id, new ClipFrames(new VideoSampleSink(videoTrack), timestamps));
      }
    }

    const pending = new Map<string, CanvasImageSource | null>();

    for (let i = 0; i < totalFrames; i += 1) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
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
      drawFrame(ctx, scaled, t, (clip) => pending.get(clip.id) ?? null, { guides: false });
      await videoSource.add(i / fps, 1 / fps);

      if (i % 5 === 0 || i === totalFrames - 1) {
        onProgress?.({
          stage: "video",
          progress: (i + 1) / totalFrames,
          frame: i + 1,
          totalFrames,
        });
      }
    }

    onProgress?.({ stage: "finalising", progress: 1, frame: totalFrames, totalFrames });
    await output.finalize();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Export produced no data.");
    return new Blob([buffer], {
      type: options.container === "mp4" ? "video/mp4" : "video/webm",
    });
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    for (const source of frames.values()) source.close();
    for (const bitmap of stills.values()) bitmap.close();
    for (const input of inputs) input.dispose();
  }
}
