/**
 * One source, one MediaRecorder, one file on disk.
 *
 * The class exists mostly to keep `start()` synchronous. Opening the file and
 * constructing the recorder are async, and if that work happened at start time
 * the tracks in a session would begin milliseconds apart and drift into each
 * other's lip sync. So all of it moves into `prepare()`, and `start()` does
 * nothing but read the clock and call through.
 */

import type { ArmedSource, PauseSpan, TrackMeta } from "./types";
import { extensionFor } from "./mime";
import type { OpfsWriter } from "./storage";

/** How often the recorder hands us bytes. Smaller means less lost to a crash. */
const TIMESLICE_MS = 1000;

function defaultVideoBitrate(source: ArmedSource): number {
  const settings = source.stream.getVideoTracks()[0]?.getSettings() ?? {};
  const pixels = (settings.width ?? 1280) * (settings.height ?? 720);
  const fps = settings.frameRate ?? 30;
  // Roughly 0.11 bits per pixel per frame — enough for screen text to stay
  // crisp, which is where an under-provisioned bitrate shows up first.
  const bits = Math.round(pixels * fps * 0.11);
  return Math.min(Math.max(bits, 1_500_000), 24_000_000);
}

export interface TrackRecorderOptions {
  sessionId: string;
  mimeType: string;
  audioBitsPerSecond?: number;
  videoBitsPerSecond?: number;
}

export class TrackRecorder {
  readonly source: ArmedSource;
  readonly fileName: string;

  private writer: OpfsWriter;
  private options: TrackRecorderOptions;
  private recorder: MediaRecorder | null = null;

  /** Serialises chunk writes; Blob.arrayBuffer() alone would let them race. */
  private chain: Promise<void> = Promise.resolve();

  private clockOrigin = 0;
  private offsetMs = 0;
  private runStartedAt = 0;
  private recordedMs = 0;
  private pauses: PauseSpan[] = [];
  private pauseStartedAt = 0;
  private failure: string | null = null;

  constructor(source: ArmedSource, writer: OpfsWriter, options: TrackRecorderOptions) {
    this.source = source;
    this.writer = writer;
    this.options = options;
    this.fileName = `${source.kind}.${extensionFor(options.mimeType)}`;
  }

  get id(): string {
    return this.source.id;
  }

  get error(): string | null {
    return this.failure;
  }

  /** Everything expensive, done before the user's clock starts. */
  async prepare(): Promise<void> {
    await this.writer.open(this.source.id, this.options.sessionId, this.fileName);

    const recorder = new MediaRecorder(this.source.stream, {
      mimeType: this.options.mimeType,
      ...(this.source.stream.getVideoTracks().length > 0
        ? { videoBitsPerSecond: this.options.videoBitsPerSecond ?? defaultVideoBitrate(this.source) }
        : {}),
      ...(this.source.stream.getAudioTracks().length > 0
        ? { audioBitsPerSecond: this.options.audioBitsPerSecond ?? 128_000 }
        : {}),
    });

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const blob = event.data;
      this.chain = this.chain.then(async () => {
        const buffer = await blob.arrayBuffer();
        this.writer.write(this.source.id, buffer);
      });
    };
    recorder.onerror = (event) => {
      const err = (event as unknown as { error?: DOMException }).error;
      this.failure = err?.message ?? "Recording failed.";
    };

    this.recorder = recorder;
  }

  /** Synchronous on purpose — see the class comment. */
  start(clockOrigin: number): void {
    if (!this.recorder) throw new Error("start() before prepare()");
    this.clockOrigin = clockOrigin;
    const now = performance.now();
    this.offsetMs = now - clockOrigin;
    this.runStartedAt = now;
    this.recorder.start(TIMESLICE_MS);
  }

  pause(): void {
    if (this.recorder?.state !== "recording") return;
    this.recorder.pause();
    const now = performance.now();
    this.recordedMs += now - this.runStartedAt;
    this.pauseStartedAt = now;
  }

  resume(): void {
    if (this.recorder?.state !== "paused") return;
    this.recorder.resume();
    const now = performance.now();
    this.pauses.push({
      at: this.pauseStartedAt - this.clockOrigin,
      ms: now - this.pauseStartedAt,
    });
    this.runStartedAt = now;
  }

  async stop(): Promise<TrackMeta> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("stop() before prepare()");

    if (recorder.state === "recording") {
      this.recordedMs += performance.now() - this.runStartedAt;
    } else if (recorder.state === "paused") {
      // Stopped while paused: the pause never resumed, so close it out here.
      this.pauses.push({
        at: this.pauseStartedAt - this.clockOrigin,
        ms: performance.now() - this.pauseStartedAt,
      });
    }

    if (recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }

    // The final dataavailable fires before `stop`, but its arrayBuffer() may
    // still be in flight — so drain the chain before closing the file.
    await this.chain;
    const bytes = await this.writer.close(this.source.id);

    this.source.stream.getTracks().forEach((t) => t.stop());
    return this.describe(bytes);
  }

  async abort(): Promise<void> {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    await this.chain.catch(() => {});
    await this.writer.abort(this.source.id).catch(() => {});
    this.source.stream.getTracks().forEach((t) => t.stop());
  }

  private describe(bytes: number): TrackMeta {
    const video = this.source.stream.getVideoTracks()[0]?.getSettings();
    const audio = this.source.stream.getAudioTracks()[0]?.getSettings();
    return {
      id: this.source.id,
      kind: this.source.kind,
      label: this.source.label,
      mimeType: this.options.mimeType,
      fileName: this.fileName,
      bytes,
      offsetMs: Math.round(this.offsetMs),
      durationMs: Math.round(this.recordedMs),
      pauses: this.pauses.map((p) => ({ at: Math.round(p.at), ms: Math.round(p.ms) })),
      ...(video?.width !== undefined ? { width: video.width } : {}),
      ...(video?.height !== undefined ? { height: video.height } : {}),
      ...(video?.frameRate !== undefined ? { frameRate: video.frameRate } : {}),
      ...(audio?.sampleRate !== undefined ? { sampleRate: audio.sampleRate } : {}),
      ...(audio?.channelCount !== undefined ? { channelCount: audio.channelCount } : {}),
    };
  }
}
