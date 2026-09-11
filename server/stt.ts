/**
 * Speech-to-text services, one adapter per kind of API.
 *
 * Transcription is not tied to one engine or one machine. Someone with a fast
 * Mac runs whisper.cpp locally; someone without sends the audio to OpenAI,
 * Groq, OpenRouter or ElevenLabs. Most of those speak OpenAI's
 * /audio/transcriptions, with differences that matter — how long a request may
 * run, how big an upload may be, what comes back for a script that is not
 * Latin — and ElevenLabs has an API of its own. Each adapter turns one part of
 * audio into timed words and says how long a part it can take; `transcribe.ts`
 * does everything else, the same for all of them.
 *
 * Adding a service is one adapter here and one preset in the Captions panel.
 */

import path from "node:path";
import { wordsFromVerboseJson, type Transcript, type TranscriptWord, type VerboseJson } from "../src/editor/transcript";
import { authHeaders, endpoint, silentWav, type Capabilities, type Provider, type ProviderKind } from "./ai";

export interface PartResult {
  words: TranscriptWord[];
  timing: Transcript["timing"];
  language: string | null;
}

export interface SttAdapter {
  /** The longest stretch of audio to send in one request, seconds. */
  partSeconds(provider: Provider): number;
  /** The largest upload the service takes, bytes, with a margin. */
  maxBytes(provider: Provider): number;
  /** How many requests to have in flight at once. */
  concurrency(provider: Provider): number;
  /** Words timed from the start of `file`. `name` carries the format in its extension. */
  transcribe(provider: Provider, file: string, name: string, language?: string): Promise<PartResult>;
  /** What the service can do, found by trying it. */
  probe(provider: Provider): Promise<Capabilities>;
}

const MB = 1024 * 1024;

/** One request, with errors that say what to do about them. */
async function send(provider: Provider, url: string, body: FormData): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(provider),
      body,
      signal: AbortSignal.timeout(30 * 60_000),
    });
  } catch (err) {
    // "fetch failed" tells nobody anything. The usual cause is a local server
    // that was stopped since it was connected.
    throw new Error(
      `Could not reach ${provider.baseUrl} — is the service running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(
      response.status === 401 || response.status === 403
        ? `${provider.name} refused the API key (${response.status}). ${detail}`
        : `${provider.name} answered ${response.status}: ${detail}`,
    );
  }
  return response;
}

interface Tried {
  transcribe: boolean;
  reachable: boolean;
  message?: string;
  /** The Server header, which is how a whisper.cpp server is recognised. */
  server?: string;
}

/** A quarter-second of silence: the cheapest honest answer to "can it transcribe?". */
async function tryTranscribing(provider: Provider, url: string, form: FormData): Promise<Tried> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(provider),
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const server = response.headers.get("server") ?? undefined;
    if (response.ok) return { transcribe: true, reachable: true, ...(server ? { server } : {}) };
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 160);
    const message =
      response.status === 404 || response.status === 405
        ? `This service has no transcription endpoint (${response.status}).`
        : response.status === 401 || response.status === 403
          ? `The API key was refused (${response.status}).`
          : `Transcription failed: ${response.status} ${detail}`;
    return { transcribe: false, reachable: true, message, ...(server ? { server } : {}) };
  } catch (err) {
    return {
      transcribe: false,
      reachable: false,
      message: `Could not reach ${provider.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const silence = () => new Blob([silentWav(0.25)], { type: "audio/wav" });

/* ------------------------------------------------- OpenAI-compatible */

type Flavor = NonNullable<Capabilities["flavor"]>;

function hostFlavor(baseUrl: string): Flavor | undefined {
  try {
    return new URL(baseUrl).hostname.endsWith("openrouter.ai") ? "openrouter" : undefined;
  } catch {
    return undefined;
  }
}

const flavorOf = (provider: Provider): Flavor | undefined => provider.capabilities?.flavor ?? hostFlavor(provider.baseUrl);

/**
 * OpenAI, Groq, OpenRouter, whisper.cpp's server, speaches, LocalAI — anything
 * that serves /audio/transcriptions with verbose_json and word timestamps.
 */
const openai: SttAdapter = {
  partSeconds(provider) {
    switch (flavorOf(provider)) {
      // Over a long part whisper.cpp can fall into one phrase and repeat it for
      // minutes: nine minutes of Hindi came back as "re re re…" from the
      // thirtieth second on. Two-minute parts bound the damage, and cost
      // nothing — it runs locally.
      case "whisper.cpp":
        return 120;
      // OpenRouter gives the model behind it 60 s per request.
      case "openrouter":
        return 300;
      default:
        return 600;
    }
  },
  maxBytes(provider) {
    // OpenAI, Groq's free tier and OpenRouter all refuse an upload over 25 MB.
    return flavorOf(provider) === "whisper.cpp" ? Number.POSITIVE_INFINITY : 24 * MB;
  },
  // A hosted request took ~35 s through OpenRouter however short its audio,
  // so parts go side by side; a local server has one model and takes turns.
  concurrency: (provider) => (flavorOf(provider) === "whisper.cpp" ? 1 : 4),
  async transcribe(provider, file, name, language) {
    const form = new FormData();
    form.set("file", Bun.file(file), name);
    form.set("model", provider.transcribeModel);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    if (language) form.set("language", language);
    if (flavorOf(provider) === "whisper.cpp") {
      // whisper.cpp's word times come as byte-level tokens, which split any
      // multi-byte script mid-character — Hindi arrived as "��". One word per
      // segment, split on word boundaries, gives whole words with their times.
      // Other services would reject the unknown fields, so only here.
      form.set("max_len", "1");
      form.set("split_on_word", "true");
    }
    const response = await send(provider, endpoint(provider, "audio/transcriptions"), form);
    const json = (await response.json()) as VerboseJson;
    return { ...wordsFromVerboseJson(json), language: json.language ?? null };
  },
  async probe(provider) {
    let reachable = false;
    let models: string[] = [];
    try {
      const response = await fetch(endpoint(provider, "models"), {
        headers: authHeaders(provider),
        signal: AbortSignal.timeout(5000),
      });
      reachable = true;
      if (response.ok) {
        const body = (await response.json()) as { data?: { id: string }[] };
        models = body.data?.map((m) => m.id) ?? [];
      }
    } catch {
      // Some transcription servers have no /models at all; the next request decides.
    }
    const form = new FormData();
    form.set("file", silence(), "probe.wav");
    form.set("model", provider.transcribeModel);
    form.set("response_format", "json");
    const tried = await tryTranscribing(provider, endpoint(provider, "audio/transcriptions"), form);
    const flavor: Flavor | undefined = tried.server?.toLowerCase().includes("whisper.cpp")
      ? "whisper.cpp"
      : hostFlavor(provider.baseUrl);
    return {
      checkedAt: Date.now(),
      reachable: reachable || tried.reachable,
      models,
      transcribe: tried.transcribe,
      ...(tried.message ? { message: tried.message } : {}),
      ...(flavor ? { flavor } : {}),
    };
  },
};

/* -------------------------------------------------------- ElevenLabs */

interface ScribeResponse {
  language_code?: string;
  words?: { text: string; type: string; start: number; end: number }[];
}

/** ElevenLabs Scribe: an API of its own, a time on every word, uploads of gigabytes. */
const elevenlabs: SttAdapter = {
  // One request could hold hours; half an hour keeps a failure cheap to retry.
  partSeconds: () => 1800,
  maxBytes: () => 1000 * MB,
  concurrency: () => 2,
  async transcribe(provider, file, name, language) {
    const form = new FormData();
    form.set("file", Bun.file(file), name);
    form.set("model_id", provider.transcribeModel);
    form.set("timestamps_granularity", "word");
    form.set("tag_audio_events", "false");
    if (language) form.set("language_code", language);
    const response = await send(provider, endpoint(provider, "speech-to-text"), form);
    const json = (await response.json()) as ScribeResponse;
    // Spaces and audio events come interleaved with the words, as items of their own.
    const words = (json.words ?? [])
      .filter((w) => w.type === "word" && w.text.trim())
      .map((w) => ({ start: w.start, end: Math.max(w.start, w.end), text: w.text.trim() }));
    return { words, timing: "word", language: json.language_code ?? null };
  },
  async probe(provider) {
    const form = new FormData();
    form.set("file", silence(), "probe.wav");
    form.set("model_id", provider.transcribeModel);
    const tried = await tryTranscribing(provider, endpoint(provider, "speech-to-text"), form);
    return {
      checkedAt: Date.now(),
      reachable: tried.reachable,
      models: [],
      transcribe: tried.transcribe,
      ...(tried.message ? { message: tried.message } : {}),
    };
  },
};

/* --------------------------------------------------------- Anthropic */

/** Anthropic has no speech-to-text. It is connected for the Director, and says so here. */
const anthropic: SttAdapter = {
  partSeconds: () => 600,
  maxBytes: () => 0,
  concurrency: () => 1,
  async transcribe() {
    throw new Error("Anthropic has no speech-to-text. Connect a transcription service in the Captions panel.");
  },
  async probe() {
    return { checkedAt: Date.now(), reachable: false, models: [], transcribe: false, message: "No speech-to-text: Anthropic is for the Director." };
  },
};

/* ------------------------------------------------------------ lookup */

const ADAPTERS: Record<ProviderKind, SttAdapter> = { openai, elevenlabs, anthropic };

export const PROVIDER_KINDS = Object.keys(ADAPTERS) as ProviderKind[];

export const adapterFor = (provider: Provider): SttAdapter => ADAPTERS[provider.kind] ?? openai;

export const probe = (provider: Provider): Promise<Capabilities> => adapterFor(provider).probe(provider);

const FROM_MIME: [RegExp, string][] = [
  [/webm/, "webm"],
  [/mp4|m4a|quicktime|aac/, "m4a"],
  [/mpeg|mp3/, "mp3"],
  [/wav/, "wav"],
  [/ogg/, "ogg"],
  [/flac/, "flac"],
];

/**
 * The file name to upload under. Services infer the format from its
 * extension, and an imported file is stored under its asset id with none.
 */
export function uploadName(file: string, mime: string): string {
  const ext = path.extname(file).slice(1).toLowerCase() || FROM_MIME.find(([re]) => re.test(mime))?.[1] || "webm";
  return `audio.${ext}`;
}
