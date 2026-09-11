/**
 * Transcribing a file through whichever speech-to-text service is connected.
 *
 * Long audio goes in parts, each as long as the service takes in one request —
 * `stt.ts` says how long for each: hosted services cap an upload (OpenAI and
 * OpenRouter at 25 MB) or a request's running time, and whisper.cpp drifts
 * into repeating itself over a long one. A part is a copy of the packets, not a
 * re-encode, and reaches a couple of seconds into its neighbours, so a word on
 * a cut is heard whole in one of them; each word is kept from the part its
 * middle falls in. A file with video sends only its audio.
 *
 * Then every hole is heard again. Hosted Whisper drops the last seconds of
 * each thirty-second window it decodes: nine minutes of Hindi through
 * OpenRouter lost 141 s of speech, a few seconds out of every half-minute, and
 * cutting the audio into 26 s parts only moved the holes to the ends of the
 * parts. So any stretch longer than `HOLE_SECONDS` with no word in it is sent
 * again, in the middle of a short part of its own. A hole that really was
 * silence comes back empty, having cost a few seconds of audio.
 *
 * Results are cached beside the file, so the same recording opened in a
 * second project is not transcribed, or paid for, twice.
 */

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  FilePathSource,
  FilePathTarget,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import { dropLoops, type Transcript, type TranscriptWord } from "../src/editor/transcript";
import type { Provider } from "./ai";
import { adapterFor, uploadName } from "./stt";

export interface TranscribeOptions {
  /** ISO 639-1, e.g. "hi" or "en". Omitted means the service detects it. */
  language?: string;
  /** Longest part, seconds. The service's own limit applies when it is shorter. */
  chunkSeconds?: number;
  /** Ignore a cached transcript. */
  force?: boolean;
  onProgress?: (fraction: number, note: string) => void;
}

/** How far each part reaches into its neighbours, seconds. */
const OVERLAP_SECONDS = 2;
/** A stretch this long with no word in it is heard again. */
const HOLE_SECONDS = 2.5;
/** A hole is re-heard in pieces of at most this, each padded on both sides. */
const HOLE_PIECE_SECONDS = 16;
const HOLE_PAD_SECONDS = 6;

/** Runs jobs with at most `lanes` in flight, keeping results in order. */
async function inLanes<T>(jobs: (() => Promise<T>)[], lanes: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(lanes, jobs.length)) }, async () => {
      while (next < jobs.length) {
        const index = next++;
        results[index] = await jobs[index]!();
      }
    }),
  );
  return results;
}

/** Stretches of the file with no word in them, longer than HOLE_SECONDS. */
function holesIn(words: TranscriptWord[], duration: number): [number, number][] {
  const holes: [number, number][] = [];
  let heardTo = 0;
  for (const w of words) {
    if (w.start - heardTo > HOLE_SECONDS) holes.push([heardTo, w.start]);
    heardTo = Math.max(heardTo, w.end);
  }
  if (duration - heardTo > HOLE_SECONDS) holes.push([heardTo, duration]);
  return holes;
}

async function probeFile(file: string): Promise<{ duration: number; hasVideo: boolean; mime: string; bitrate: number }> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const audio = await input.getPrimaryAudioTrack();
    const stats = audio ? await audio.computePacketStats(300).catch(() => null) : null;
    return {
      duration: await input.computeDuration(),
      hasVideo: Boolean(await input.getPrimaryVideoTrack()),
      mime: await input.getMimeType(),
      bitrate: stats?.averageBitrate ?? 0,
    };
  } finally {
    input.dispose();
  }
}

/**
 * The audio of `file` between two times, as its own small file, and the time
 * its first packet actually starts at.
 *
 * Packets are copied one by one rather than through a trimming conversion:
 * trimming makes mediabunny decode to cut at an exact sample, and this process
 * has no audio decoder — it discarded the track as "undecodable". Cutting on
 * packet boundaries instead is off by at most one packet (20 ms of Opus), and
 * the returned offset is the real start, so the words land where they belong.
 */
async function cutAudio(file: string, start: number, end: number, mime: string): Promise<{ piece: string; offset: number }> {
  const mp4 = /mp4|quicktime|m4a/.test(mime);
  const piece = `${file}.${crypto.randomUUID()}.part.${mp4 ? "m4a" : "webm"}`;
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    const codec = track?.codec;
    if (!track || !codec) throw new Error("The file has no audio that can be sent for transcription.");
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new Error("The file's audio cannot be copied.");

    const output = new Output({
      format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
      target: new FilePathTarget(piece),
    });
    const audio = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(audio);
    await output.start();

    const sink = new EncodedPacketSink(track);
    const first = (await sink.getPacket(start)) ?? (await sink.getFirstPacket());
    let offset: number | null = null;
    for await (const packet of sink.packets(first ?? undefined)) {
      if (packet.timestamp >= end) break;
      offset ??= packet.timestamp;
      // Rebased to zero: services time words from the start of what they hear.
      await audio.add(packet.clone({ timestamp: packet.timestamp - offset }), offset === packet.timestamp ? { decoderConfig } : undefined);
    }
    await output.finalize();
    return { piece, offset: offset ?? start };
  } catch (err) {
    await rm(piece, { force: true });
    throw err;
  } finally {
    input.dispose();
  }
}

export async function transcribeFile(
  source: string,
  cache: string,
  provider: Provider,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  if (!options.force) {
    try {
      return JSON.parse(await readFile(cache, "utf8")) as Transcript;
    } catch {
      // Not transcribed yet.
    }
  }

  const adapter = adapterFor(provider);
  const { duration, hasVideo, mime, bitrate } = await probeFile(source);
  const maxBytes = adapter.maxBytes(provider);
  let part = Math.min(adapter.partSeconds(provider), options.chunkSeconds ?? Number.POSITIVE_INFINITY);
  // Keep every upload under the service's cap, going by the audio's own bitrate.
  if (bitrate > 0 && Number.isFinite(maxBytes)) part = Math.min(part, (maxBytes * 8 * 0.9) / bitrate - OVERLAP_SECONDS * 2);
  part = Math.max(5, part);

  const spans: [number, number][] = [];
  for (let start = 0; start < duration; start += part) spans.push([start, Math.min(duration, start + part)]);
  const whole = spans.length === 1 && !hasVideo && (await stat(source)).size <= maxBytes;

  let timing: Transcript["timing"] = "word";
  let language: string | null = null;
  let done = 0;
  let total = spans.length;
  const tick = (note: string) => options.onProgress?.(Math.min(0.99, done / total), note);

  /** Words heard between two times of the file, kept if `keep` accepts their middle. */
  const listen = async (from: number, to: number, keep: (middle: number) => boolean, useWhole: boolean) => {
    const cut = useWhole ? { piece: source, offset: 0 } : await cutAudio(source, from, to, mime);
    try {
      const got = await adapter.transcribe(provider, cut.piece, uploadName(cut.piece, mime), options.language);
      if (got.timing === "segment") timing = "segment";
      language ??= got.language;
      return dropLoops(got.words)
        .map((w) => ({ start: w.start + cut.offset, end: w.end + cut.offset, text: w.text }))
        .filter((w) => keep((w.start + w.end) / 2));
    } finally {
      if (!useWhole) await rm(cut.piece, { force: true });
      done += 1;
    }
  };

  const lanes = adapter.concurrency(provider);
  tick(`${spans.length} part${spans.length === 1 ? "" : "s"}`);
  const parts = await inLanes(
    spans.map(([start, end], index) => async () => {
      const first = index === 0;
      const last = index === spans.length - 1;
      const heard = await listen(
        Math.max(0, start - OVERLAP_SECONDS),
        Math.min(duration, end + OVERLAP_SECONDS),
        // Each word from the part its middle falls in, so the overlap is heard once.
        (middle) => (first || middle >= start) && (last || middle < end),
        whole,
      );
      tick(`${done} of ${total} parts`);
      return heard;
    }),
    lanes,
  );
  let words = parts.flat();

  // The second pass: every hole again, centred in a short part of its own.
  const pieces: [number, number][] = holesIn(words, duration).flatMap(([a, b]) => {
    const out: [number, number][] = [];
    for (let at = a; at < b; at += HOLE_PIECE_SECONDS) out.push([at, Math.min(b, at + HOLE_PIECE_SECONDS)]);
    return out;
  });
  if (pieces.length > 0) {
    total += pieces.length;
    tick(`filling ${pieces.length} gap${pieces.length === 1 ? "" : "s"}`);
    const filled = await inLanes(
      pieces.map(([a, b]) => () =>
        listen(Math.max(0, a - HOLE_PAD_SECONDS), Math.min(duration, b + HOLE_PAD_SECONDS), (m) => m > a && m < b, false),
      ),
      lanes,
    );
    words = [...words, ...filled.flat()].sort((x, y) => x.start - y.start);
  }

  const transcript: Transcript = {
    version: 1,
    provider: provider.name,
    model: provider.transcribeModel,
    language,
    durationSec: duration,
    timing,
    words,
    createdAt: Date.now(),
  };
  const temp = `${cache}.${crypto.randomUUID()}.part`;
  await writeFile(temp, JSON.stringify(transcript));
  await rename(temp, cache);
  options.onProgress?.(1, "done");
  return transcript;
}

/* ------------------------------------------------------------------- jobs */

export interface JobView {
  status: "running" | "done" | "error";
  progress: number;
  note: string;
  result?: unknown;
  error?: string;
}

/**
 * Work that outlasts a request. An hour of audio can take minutes to
 * transcribe, longer than any sane request timeout, so the page starts a job
 * and asks after it.
 */
export class Jobs {
  private jobs = new Map<string, JobView & { finishedAt?: number }>();

  start(run: (progress: (fraction: number, note: string) => void) => Promise<unknown>): string {
    const id = crypto.randomUUID();
    const job: JobView & { finishedAt?: number } = { status: "running", progress: 0, note: "starting" };
    this.jobs.set(id, job);
    run((fraction, note) => {
      job.progress = fraction;
      job.note = note;
    })
      .then((result) => {
        Object.assign(job, { status: "done", progress: 1, note: "done", result, finishedAt: Date.now() });
      })
      .catch((err: unknown) => {
        Object.assign(job, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        });
      });
    this.sweep();
    return id;
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const { finishedAt: _finished, ...view } = job;
    return view;
  }

  /** Finished jobs are kept ten minutes, for a page that was slow to ask. */
  private sweep(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, job] of this.jobs) if (job.finishedAt && job.finishedAt < cutoff) this.jobs.delete(id);
  }
}
