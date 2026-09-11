/**
 * Export: decode, composite, encode — all in the browser, on the GPU wherever
 * the browser allows it, and off the main thread.
 *
 * The property that matters here is that the picture is produced by the same
 * `drawFrame` the preview uses. The exporter only changes where the frames come
 * from: mediabunny decodes them at exact timestamps instead of a `<video>`
 * approximating them. So an export cannot silently disagree with the preview
 * about layout, colour, effects or order.
 */

import { loadFonts } from "@/lib/fonts";
import { assetFile } from "./media";
import { assetOf, fadeGainAt, projectDuration, trackAudible } from "./project";
import type { Container } from "./presets";
import { fontsInUse } from "./themes";
import type { Clip, Project } from "./types";
import type { FromWorker, ToWorker, WorkerAudio } from "./export-worker";

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
 * Hands the mix to the worker as one planar block.
 *
 * `AudioBuffer` cannot cross a worker boundary — it belongs to an audio
 * context, and workers have none — so the channels are copied out into a single
 * `Float32Array` laid out one channel after another, which is the shape the
 * encoder wants anyway. The buffer is transferred, not cloned.
 */
function toWorkerAudio(buffer: AudioBuffer): WorkerAudio {
  const channels = buffer.numberOfChannels;
  const data = new Float32Array(buffer.length * channels);
  for (let c = 0; c < channels; c += 1) {
    data.set(buffer.getChannelData(c), c * buffer.length);
  }
  return { data, channels, sampleRate: buffer.sampleRate };
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
  if (to - from <= 0) throw new Error("There is nothing on the timeline to export.");

  // Encoders reject odd dimensions; round both down to an even number.
  const scale = options.height / project.height;
  const width = Math.round((project.width * scale) / 2) * 2;
  const height = Math.round(options.height / 2) * 2;

  onProgress?.({ stage: "audio", progress: 0, frame: 0, totalFrames: 0 });
  const mixed = await mixAudio(project, from, to);
  const audio = mixed ? toWorkerAudio(mixed) : null;

  // The worker has no document and so none of the page's fonts: it is handed
  // the files of every web font the text uses, or it would draw fallbacks.
  const fonts = await loadFonts(fontsInUse(project)).catch(() => []);

  const worker = new Worker(new URL("./export-worker.ts", import.meta.url), { type: "module" });

  return new Promise<Blob>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      worker.postMessage({ type: "cancel" } satisfies ToWorker);
      cleanup();
      reject(new DOMException("Export cancelled", "AbortError"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.({
          stage: message.stage,
          progress: message.progress,
          frame: message.frame,
          totalFrames: message.totalFrames,
        });
        return;
      }
      if (message.type === "done") {
        cleanup();
        resolve(new Blob([message.buffer], { type: message.mimeType }));
        return;
      }
      cleanup();
      reject(new Error(message.message));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "The export worker failed to start."));
    };

    const payload: ToWorker = {
      type: "run",
      // The project is plain JSON by construction, so it structured-clones
      // without any preparation — which is much of the reason it is kept that
      // way.
      project,
      options: {
        container: options.container,
        width,
        height,
        frameRate: options.frameRate,
        quality: options.quality,
        bitrateMbps: options.bitrateMbps,
        from,
        to,
      },
      audio,
      fonts,
    };
    worker.postMessage(payload, audio ? [audio.data.buffer] : []);
  });
}
