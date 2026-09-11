/**
 * Transcribing a file through the connected OpenAI-compatible service.
 *
 * Long audio goes in parts. Hosted services cap an upload (OpenAI at 25 MB),
 * and an hour of microphone is well over that, so the file is cut into
 * ten-minute pieces — a copy of the packets, not a re-encode — and each
 * piece's words are shifted back by where it started. A file with video sends
 * only its audio.
 *
 * Results are cached beside the file, so the same recording opened in a
 * second project is not transcribed, or paid for, twice.
 */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { wordsFromVerboseJson, type Transcript, type TranscriptWord, type VerboseJson } from "../src/editor/transcript";
import { authHeaders, endpoint, type Provider } from "./ai";

export interface TranscribeOptions {
  /** ISO 639-1, e.g. "hi" or "en". Omitted means the service detects it. */
  language?: string;
  /** Length of each part, seconds. Ten minutes keeps Opus far under 25 MB. */
  chunkSeconds?: number;
  /** Ignore a cached transcript. */
  force?: boolean;
  onProgress?: (fraction: number, note: string) => void;
}

async function probeFile(file: string): Promise<{ duration: number; hasVideo: boolean; mime: string }> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    return {
      duration: await input.computeDuration(),
      hasVideo: Boolean(await input.getPrimaryVideoTrack()),
      mime: await input.getMimeType(),
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

async function request(provider: Provider, file: string, language?: string): Promise<VerboseJson> {
  const form = new FormData();
  // The file name matters: services infer the format from its extension.
  form.set("file", Bun.file(file), path.basename(file).replace(/^.*\.part\./, "audio."));
  form.set("model", provider.transcribeModel);
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (language) form.set("language", language);
  let response: Response;
  try {
    response = await fetch(endpoint(provider, "audio/transcriptions"), {
      method: "POST",
      headers: authHeaders(provider),
      body: form,
      signal: AbortSignal.timeout(30 * 60_000),
    });
  } catch (err) {
    // "fetch failed" tells nobody anything. The usual cause is a local server
    // that was stopped since it was connected.
    throw new Error(`Could not reach ${provider.baseUrl} — is the transcription service running? (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`${provider.name} answered ${response.status}: ${detail}`);
  }
  return (await response.json()) as VerboseJson;
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

  const { duration, hasVideo, mime } = await probeFile(source);
  const chunk = Math.min(1800, Math.max(5, options.chunkSeconds ?? 600));
  const spans: [number, number][] = [];
  for (let start = 0; start < duration; start += chunk) spans.push([start, Math.min(duration, start + chunk)]);

  const words: TranscriptWord[] = [];
  let timing: Transcript["timing"] = "word";
  let language: string | null = null;

  for (const [index, [start, end]] of spans.entries()) {
    options.onProgress?.(index / spans.length, `part ${index + 1} of ${spans.length}`);
    const whole = spans.length === 1 && !hasVideo;
    const cut = whole ? { piece: source, offset: 0 } : await cutAudio(source, start, end, mime);
    const file = cut.piece;
    try {
      const json = await request(provider, file, options.language);
      const got = wordsFromVerboseJson(json, cut.offset);
      words.push(...got.words);
      if (got.timing === "segment") timing = "segment";
      language ??= json.language ?? null;
    } finally {
      if (!whole) await rm(file, { force: true });
    }
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
