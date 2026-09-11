/**
 * A session is the thing that makes separate files a usable set: it owns one
 * clock, and every track measures itself against it.
 *
 * `start()` walks the recorders in a tight synchronous loop with nothing
 * awaited in between, so the offsets it records are single-digit milliseconds
 * rather than however long a file open happened to take.
 */

import type { ArmedSource, SessionMeta, TrackMeta } from "./types";
import { pickMimeForStream } from "./mime";
import { OpfsWriter, deleteLocalSession, writeSessionMeta } from "./storage";
import { TrackRecorder } from "./track-recorder";
import { newId, watchForEnd } from "./sources";

/**
 * The Web Lock a session holds for as long as it is recording.
 *
 * A take being recorded and a take whose tab died look identical on disk —
 * files, and no meta.json — so recovery needs another way to tell them apart.
 * The browser releases the lock the moment the tab goes, and `navigator.locks`
 * is shared across the origin's tabs, so a take recording in another window is
 * still seen as live.
 */
export function recordingLockName(sessionId: string): string {
  return `cutline-recording:${sessionId}`;
}

export interface SessionOptions {
  name: string;
  /** Called when a source is revoked externally — the browser's Stop sharing bar. */
  onSourceEnded?: (source: ArmedSource) => void;
  /** Called as bytes land on disk, keyed by source id. */
  onProgress?: (id: string, bytes: number) => void;
  onStorageError?: (message: string) => void;
}

export class RecordingSession {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;

  private writer: OpfsWriter;
  private recorders: TrackRecorder[] = [];
  private unwatchers: (() => void)[] = [];
  private clockOrigin = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private stopped = false;
  private releaseLock: (() => void) | null = null;

  private constructor(id: string, name: string, writer: OpfsWriter) {
    this.id = id;
    this.name = name;
    this.createdAt = Date.now();
    this.writer = writer;
  }

  /**
   * Opens every file and builds every MediaRecorder. Nothing is recording when
   * this resolves — that is the point of separating it from `start()`.
   */
  static async prepare(
    sources: ArmedSource[],
    options: SessionOptions,
  ): Promise<RecordingSession> {
    if (sources.length === 0) throw new Error("A recording needs at least one source.");

    const session = new RecordingSession(newId(), options.name, new OpfsWriter());
    // Before any file exists, so there is no moment where the take's files
    // are on disk without the lock that says it is live.
    await session.holdLock();

    session.writer.onProgress = (id, bytes) => options.onProgress?.(id, bytes);
    session.writer.onError = (_id, message) => options.onStorageError?.(message);

    try {
      for (const source of sources) {
        const mimeType = pickMimeForStream(source.stream);
        if (!mimeType) throw new Error(`No supported recording format for ${source.kind}.`);

        const recorder = new TrackRecorder(source, session.writer, {
          sessionId: session.id,
          mimeType,
        });
        await recorder.prepare();
        session.recorders.push(recorder);

        if (options.onSourceEnded) {
          session.unwatchers.push(
            watchForEnd(source, () => options.onSourceEnded?.(source)),
          );
        }
      }
    } catch (err) {
      await session.abort();
      throw err;
    }

    return session;
  }

  /** The clock's origin as wall-clock ms, for anything recorded outside this page. */
  get clockOriginWall(): number {
    return performance.timeOrigin + this.clockOrigin;
  }

  private holdLock(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.locks) return Promise.resolve();
    return new Promise((acquired) => {
      void navigator.locks.request(recordingLockName(this.id), () => {
        acquired();
        return new Promise<void>((release) => {
          this.releaseLock = release;
        });
      });
    });
  }

  private unlock(): void {
    this.releaseLock?.();
    this.releaseLock = null;
  }

  get trackCount(): number {
    return this.recorders.length;
  }

  /** Milliseconds since the clock started, paused time included. */
  elapsedMs(): number {
    if (this.clockOrigin === 0) return 0;
    if (this.pausedAt !== 0) return this.pausedAt - this.clockOrigin;
    return performance.now() - this.clockOrigin;
  }

  /** Milliseconds of actual recorded content, paused time excluded. */
  recordedMs(): number {
    const pausedNow = this.pausedAt !== 0 ? performance.now() - this.pausedAt : 0;
    return Math.max(0, this.elapsedMs() - this.pausedTotal - pausedNow);
  }

  start(): void {
    const origin = performance.now();
    this.clockOrigin = origin;
    for (const recorder of this.recorders) recorder.start(origin);
  }

  pause(): void {
    if (this.pausedAt !== 0) return;
    this.pausedAt = performance.now();
    for (const recorder of this.recorders) recorder.pause();
  }

  resume(): void {
    if (this.pausedAt === 0) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = 0;
    for (const recorder of this.recorders) recorder.resume();
  }

  /** Any per-track failures collected during the take, for honest reporting. */
  errors(): string[] {
    return this.recorders
      .map((r) => (r.error ? `${r.source.label}: ${r.error}` : null))
      .filter((x): x is string => x !== null);
  }

  async stop(): Promise<SessionMeta> {
    if (this.stopped) throw new Error("Session already stopped.");
    this.stopped = true;
    this.unwatchers.forEach((off) => off());

    const tracks: TrackMeta[] = [];
    for (const recorder of this.recorders) {
      tracks.push(await recorder.stop());
    }

    // The timeline runs from the earliest track's start to the latest track's
    // end. Paused time is not part of it: every track pauses together, so the
    // files stay aligned with each other even though they are shorter than the
    // wall clock the user watched.
    const durationMs = tracks.reduce((max, t) => Math.max(max, t.offsetMs + t.durationMs), 0);

    const meta: SessionMeta = {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      durationMs: Math.round(durationMs),
      tracks,
    };
    await writeSessionMeta(meta);
    this.writer.dispose();
    // Only now: with meta.json written, the take is finished rather than live.
    this.unlock();
    return meta;
  }

  /** Throw the take away, including its partial files. */
  async abort(): Promise<void> {
    this.stopped = true;
    this.unwatchers.forEach((off) => off());
    for (const recorder of this.recorders) await recorder.abort();
    this.writer.dispose();
    // The whole directory, not just the files: an abort that races the final
    // chunk has left a 0-byte file behind, and an empty directory would still
    // read as a take to anything that lists them.
    await deleteLocalSession(this.id).catch(() => undefined);
    this.unlock();
  }
}
