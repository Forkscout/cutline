/**
 * The cursor, recorded beside a screen capture.
 *
 * A page only receives pointer events while the pointer is over it, and during
 * a screen recording the user is in some other app. The operating system knows
 * where the cursor is, though, and this server runs on that operating system.
 * So the server samples it for the length of the take and writes it next to
 * the take's files, where auto-zoom and cursor smoothing can read it later.
 *
 * This is the one piece of a recording that has to be captured at the time:
 * a take recorded without it can never be auto-zoomed afterwards.
 *
 * macOS only for now, through a long-running JXA process — `NSEvent`'s
 * `mouseLocation` and `pressedMouseButtons` need no permission and nothing has
 * to be compiled. Other platforms answer "unsupported" and the take records
 * normally without a cursor track.
 *
 * File format, `cursor.jsonl`: one JSON header line, then one `[t, x, y, b]`
 * line per sample —
 *   t  ms of recorded content since the session clock's origin, pauses removed
 *      (the same time base as every track's `offsetMs` and `durationMs`)
 *   x, y  global display points, origin at the bottom-left of the primary
 *      display, y upwards (Cocoa's space; the header carries every display's
 *      frame so a reader can map into the captured picture)
 *   b  pressed-button bitmask: 1 left, 2 right, 4 middle
 * Consecutive identical samples are collapsed; the last one of a run is kept
 * when the cursor moves again, so interpolating never invents motion.
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FileSink, Subprocess } from "bun";

/** Printed once as `S <json>`, then one `<wallMs> <x> <y> <buttons>` per sample. */
const SAMPLER = `
ObjC.import("AppKit");
const list = $.NSScreen.screens;
const screens = [];
for (let i = 0; i < list.count; i++) {
  const s = list.objectAtIndex(i);
  const f = s.frame;
  screens.push({ x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height, scale: Number(s.backingScaleFactor) });
}
console.log("S " + JSON.stringify(screens));
const step = 1000 / 60;
let next = Date.now();
while (true) {
  const p = $.NSEvent.mouseLocation;
  console.log(Date.now() + " " + p.x + " " + p.y + " " + Number($.NSEvent.pressedMouseButtons));
  next += step;
  const wait = next - Date.now();
  if (wait > 0) $.NSThread.sleepForTimeInterval(wait / 1000);
  else next = Date.now();
}
`;

/** What the page knows about the captured surface, from the track's settings. */
export interface CaptureInfo {
  surface?: string;
  width?: number;
  height?: number;
}

type Sample = [number, number, number, number];

const round1 = (n: number) => Math.round(n * 10) / 10;

export class CursorRecording {
  private proc: Subprocess<"ignore", "ignore", "pipe"> | null = null;
  private sink: FileSink | null = null;
  private pauses: { from: number; to: number | null }[] = [];
  private lastWritten: Sample | null = null;
  private heldRepeat: Sample | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private done: Promise<void> | null = null;
  samples = 0;

  constructor(
    readonly file: string,
    private originWall: number,
    private capture: CaptureInfo,
  ) {}

  async start(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    this.sink = Bun.file(this.file).writer();
    this.proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", SAMPLER], {
      stdin: "ignore",
      stdout: "ignore",
      // JXA's console.log writes to stderr, unbuffered — which is what a
      // stream of samples wants.
      stderr: "pipe",
    });
    // Written through as it arrives, so a crash mid-take keeps what it had.
    this.flushTimer = setInterval(() => void this.sink?.flush(), 1000);
    this.done = this.read(this.proc.stderr);
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        this.line(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
  }

  private line(text: string): void {
    if (text.startsWith("S ")) {
      const header = {
        version: 1,
        source: "macos-nsevent",
        space: "display points, origin bottom-left of the primary display, y up",
        buttons: "bitmask: 1 left, 2 right, 4 middle",
        originWall: this.originWall,
        capture: this.capture,
        screens: JSON.parse(text.slice(2)) as unknown,
      };
      this.sink?.write(`${JSON.stringify(header)}\n`);
      return;
    }
    const [wallText, xText, yText, bText] = text.split(" ");
    const wall = Number(wallText);
    if (!Number.isFinite(wall)) return;
    const t = this.contentTime(wall);
    if (t === null) return;
    this.push([Math.round(t), round1(Number(xText)), round1(Number(yText)), Number(bText) || 0]);
  }

  /** Wall-clock ms to content ms, or null while paused or before the take began. */
  private contentTime(wall: number): number | null {
    let paused = 0;
    for (const span of this.pauses) {
      if (wall >= span.from && (span.to === null || wall < span.to)) return null;
      if (span.to !== null && span.to <= wall) paused += span.to - span.from;
    }
    const t = wall - this.originWall - paused;
    return t < 0 ? null : t;
  }

  private push(sample: Sample): void {
    const last = this.lastWritten;
    if (last && last[1] === sample[1] && last[2] === sample[2] && last[3] === sample[3]) {
      this.heldRepeat = sample;
      return;
    }
    if (this.heldRepeat) this.write(this.heldRepeat);
    this.heldRepeat = null;
    this.write(sample);
  }

  private write(sample: Sample): void {
    this.sink?.write(`${JSON.stringify(sample)}\n`);
    this.lastWritten = sample;
    this.samples += 1;
  }

  pause(wall: number): void {
    const open = this.pauses[this.pauses.length - 1];
    if (open && open.to === null) return;
    this.pauses.push({ from: wall, to: null });
  }

  resume(wall: number): void {
    const open = this.pauses[this.pauses.length - 1];
    if (open && open.to === null) open.to = wall;
  }

  /** Ends the sampler and closes the file. Safe to call more than once. */
  async stop(): Promise<number> {
    if (this.proc) {
      this.proc.kill();
      await this.proc.exited;
      await this.done;
      this.proc = null;
      // The cursor's final resting place, so the track runs to the end.
      if (this.heldRepeat) this.write(this.heldRepeat);
      this.heldRepeat = null;
    }
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.sink) {
      await this.sink.end();
      this.sink = null;
    }
    return this.samples;
  }
}

/** One recording at a time — there is one cursor. */
export class CursorService {
  private active: CursorRecording | null = null;

  get supported(): boolean {
    return process.platform === "darwin";
  }

  async start(file: string, originWall: number, capture: CaptureInfo): Promise<CursorRecording> {
    if (!this.supported) throw new Error(`Cursor capture is not supported on ${process.platform} yet.`);
    if (this.active) await this.active.stop();
    const recording = new CursorRecording(file, originWall, capture);
    await recording.start();
    this.active = recording;
    return recording;
  }

  async stop(recording: CursorRecording): Promise<number> {
    if (this.active === recording) this.active = null;
    return recording.stop();
  }

  /** For a discarded take: stop, and leave nothing behind. */
  async discard(recording: CursorRecording): Promise<void> {
    await this.stop(recording);
    await rm(recording.file, { force: true });
  }
}
