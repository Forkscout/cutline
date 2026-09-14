/**
 * Text to speech, one adapter per kind of API: the voice role.
 *
 * A voiceover is a script read by a model. The server makes the call with the
 * key it holds and hands the page the audio, which is imported like any other
 * sound. OpenAI's /audio/speech is spoken by OpenAI, by OpenRouter — which
 * routes it to Gemini TTS, MiniMax, Mistral, Deepgram and more — and by local
 * servers such as Kokoro-FastAPI; ElevenLabs has an API of its own.
 *
 * Voices belong to a model, not to a service. OpenRouter lists each speech
 * model's voices on its public models API, ElevenLabs lists the account's, a
 * local server may list its own, and OpenAI's are a fixed set.
 */

import { authHeaders, endpoint, type Capabilities, type Provider, type ProviderKind } from "./ai";

export interface Voice {
  id: string;
  name: string;
}

export interface SpeechRequest {
  text: string;
  voice?: string;
  /** 1 is normal; models that cannot change pace ignore it. */
  speed?: number;
  /** How to read it, for models that take directions. */
  instructions?: string;
}

export interface Speech {
  audio: Uint8Array;
  mime: string;
  model: string;
  voice: string;
}

export interface TtsAdapter {
  /** The longest script the service reads in one request. */
  maxChars(provider: Provider): number;
  voices(provider: Provider): Promise<Voice[]>;
  speak(provider: Provider, request: SpeechRequest, signal?: AbortSignal): Promise<Speech>;
}

/** What OpenAI's speech models speak. */
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

const hostOf = (provider: Provider): string => {
  try {
    return new URL(provider.baseUrl).hostname;
  } catch {
    return "";
  }
};

async function reach(provider: Provider, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`Could not reach ${provider.baseUrl} — is the service running? (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function failure(provider: Provider, response: Response, doing: string): Promise<Error> {
  const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
  return new Error(
    response.status === 401 || response.status === 403
      ? `${provider.name} refused the API key (${response.status}). ${detail}`
      : `${provider.name} could not ${doing}: ${response.status} ${detail}`,
  );
}

/** Raw 16-bit mono PCM, given a header so it can be imported: what a service sends when it will not send MP3. */
export function pcmToWav(pcm: Uint8Array, rate = 24_000): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, 44);
  return bytes;
}

/** Audio from a response, or why there is none: a 200 carrying JSON has not spoken, whatever it says. */
async function audioFrom(provider: Provider, response: Response): Promise<{ audio: Uint8Array; mime: string }> {
  const type = (response.headers.get("content-type") ?? "audio/mpeg").toLowerCase();
  if (/json|text|html/.test(type)) throw new Error(`${provider.name} answered with ${type}, not audio: ${(await response.text()).replace(/\s+/g, " ").slice(0, 200)}`);
  const audio = new Uint8Array(await response.arrayBuffer());
  if (/pcm|l16/.test(type)) return { audio: pcmToWav(audio, Number(/rate=(\d+)/.exec(type)?.[1]) || 24_000), mime: "audio/wav" };
  return { audio, mime: type.includes("wav") ? "audio/wav" : "audio/mpeg" };
}

/* ------------------------------------------------- OpenAI-compatible */

type Catalogue = { id: string; canonical_slug?: string; supported_voices?: string[] | null }[];

/** A model's voices in OpenRouter's catalogue, by id or by its dated slug; null when the model is not a speech model there. */
export function voicesInCatalogue(models: Catalogue, model: string): string[] | null {
  const found = models.find((m) => m.id === model || m.canonical_slug === model);
  return found ? (found.supported_voices ?? []) : null;
}

const catalogues = new Map<string, { at: number; models: Catalogue }>();

/** OpenRouter's speech models, read at most once an hour: public, and the same for everyone. */
async function openRouterCatalogue(provider: Provider): Promise<Catalogue> {
  const cached = catalogues.get(provider.baseUrl);
  if (cached && Date.now() - cached.at < 3600_000) return cached.models;
  const response = await reach(provider, endpoint(provider, "models?output_modalities=speech"), {
    headers: authHeaders(provider),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await failure(provider, response, "list its speech models");
  const models = ((await response.json()) as { data?: Catalogue }).data ?? [];
  catalogues.set(provider.baseUrl, { at: Date.now(), models });
  return models;
}

/**
 * Models that refuse MP3, by service and model: Gemini TTS through OpenRouter
 * answers 400 "only supports response_format=pcm". Asked for PCM from then on,
 * and given a WAV header, rather than failing every time.
 */
const pcmOnly = new Set<string>();

const onlyPcm = (detail: string) => /response_format/i.test(detail) && /\bpcm\b/i.test(detail);

const openai: TtsAdapter = {
  // OpenAI's own limit is 4,096 characters; the rest are similar or more.
  maxChars: () => 4000,
  async voices(provider) {
    const model = provider.voiceModel ?? "";
    const host = hostOf(provider);
    if (host.endsWith("openrouter.ai")) {
      const voices = voicesInCatalogue(await openRouterCatalogue(provider), model);
      if (voices === null) throw new Error(`OpenRouter has no speech model called ${model}. Its speech models: openrouter.ai/models?output_modalities=speech`);
      return voices.map((id) => ({ id, name: id }));
    }
    if (host === "api.openai.com") return OPENAI_VOICES.map((id) => ({ id, name: id }));
    // A server on this machine may say what it has: Kokoro-FastAPI and speaches answer here.
    try {
      const response = await fetch(endpoint(provider, "audio/voices"), { headers: authHeaders(provider), signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = (await response.json()) as { voices?: (string | { id?: string; voice_id?: string; name?: string })[] };
        const voices = (body.voices ?? []).flatMap((v) => {
          const id = typeof v === "string" ? v : (v.id ?? v.voice_id);
          return id ? [{ id, name: typeof v === "string" ? v : (v.name ?? id) }] : [];
        });
        if (voices.length) return voices;
      }
    } catch {
      // No list: the OpenAI names are what compatible servers usually accept.
    }
    return OPENAI_VOICES.map((id) => ({ id, name: id }));
  },
  async speak(provider, request, signal) {
    const model = provider.voiceModel ?? "";
    // A model with no voice list (some on OpenRouter) is sent none and uses its own.
    const voice = request.voice || (await openai.voices(provider))[0]?.id;
    const key = `${provider.baseUrl} ${model}`;
    const ask = (format: "mp3" | "pcm") =>
      reach(provider, endpoint(provider, "audio/speech"), {
        method: "POST",
        headers: { ...authHeaders(provider), "content-type": "application/json" },
        body: JSON.stringify({
          model,
          input: request.text,
          ...(voice ? { voice } : {}),
          // OpenRouter answers raw PCM unless asked; MP3 imports anywhere, where the model allows it.
          response_format: format,
          ...(request.speed !== undefined && request.speed !== 1 ? { speed: request.speed } : {}),
          ...(request.instructions ? { instructions: request.instructions } : {}),
        }),
        signal: signal ?? AbortSignal.timeout(5 * 60_000),
      });
    let response = await ask(pcmOnly.has(key) ? "pcm" : "mp3");
    if (response.status === 400 && !pcmOnly.has(key)) {
      const detail = await response.text();
      if (!onlyPcm(detail)) throw new Error(`${provider.name} could not speak: 400 ${detail.replace(/\s+/g, " ").slice(0, 240)}`);
      pcmOnly.add(key);
      response = await ask("pcm");
    }
    if (!response.ok) throw await failure(provider, response, "speak");
    return { ...(await audioFrom(provider, response)), model, voice: voice ?? "" };
  },
};

/* -------------------------------------------------------- ElevenLabs */

const elevenlabs: TtsAdapter = {
  maxChars: () => 3000,
  async voices(provider) {
    const response = await reach(provider, endpoint(provider, "voices"), { headers: authHeaders(provider), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw await failure(provider, response, "list its voices");
    const body = (await response.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
    return (body.voices ?? []).map((v) => ({ id: v.voice_id, name: [v.name, v.labels?.accent, v.labels?.gender].filter(Boolean).join(" · ") }));
  },
  async speak(provider, request, signal) {
    const model = provider.voiceModel ?? "";
    const voice = request.voice || (await elevenlabs.voices(provider))[0]?.id;
    if (!voice) throw new Error(`${provider.name} has no voices on this account.`);
    const response = await reach(provider, endpoint(provider, `text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`), {
      method: "POST",
      headers: { ...authHeaders(provider), "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text: request.text,
        model_id: model,
        // ElevenLabs takes 0.7 to 1.2.
        ...(request.speed !== undefined && request.speed !== 1 ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, request.speed)) } } : {}),
      }),
      signal: signal ?? AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) throw await failure(provider, response, "speak");
    return { ...(await audioFrom(provider, response)), model, voice };
  },
};

/* --------------------------------------------------------- Anthropic */

const anthropic: TtsAdapter = {
  maxChars: () => 0,
  async voices() {
    throw new Error("Anthropic has no text to speech.");
  },
  async speak() {
    throw new Error("Anthropic has no text to speech. Give a voice model to another service in Services.");
  },
};

/** An image server speaks no words. */
const imageServer: TtsAdapter = {
  maxChars: () => 0,
  async voices() {
    throw new Error("An image server has no text to speech.");
  },
  async speak() {
    throw new Error("An image server has no text to speech. Give a voice model to another service in Services.");
  },
};

/* ------------------------------------------------------------ public */

const ADAPTERS: Record<ProviderKind, TtsAdapter> = { openai, elevenlabs, anthropic, a1111: imageServer };

const adapterFor = (provider: Provider): TtsAdapter => ADAPTERS[provider.kind] ?? openai;

export function listVoices(provider: Provider): Promise<Voice[]> {
  if (!provider.voiceModel) return Promise.reject(new Error(`${provider.name} has no voice model chosen.`));
  return adapterFor(provider).voices(provider);
}

/** A script read aloud. Too long for one request is a RangeError, so the caller can say to split it. */
export async function speak(provider: Provider, request: SpeechRequest, signal?: AbortSignal): Promise<Speech> {
  if (!provider.voiceModel) throw new Error(`${provider.name} has no voice model chosen.`);
  const text = request.text.trim();
  if (!text) throw new Error("There is nothing to say.");
  const max = adapterFor(provider).maxChars(provider);
  if (text.length > max) {
    throw new RangeError(`${text.length} characters is more than ${provider.name} reads at once (${max}). Split the script: a clip per paragraph is easier to edit anyway.`);
  }
  const speech = await adapterFor(provider).speak(provider, { ...request, text }, signal);
  if (speech.audio.byteLength < 64) throw new Error(`${provider.name} sent back no audio.`);
  return speech;
}

/** Whether the chosen voice model speaks, found by having it say one word — a few characters' worth. */
export async function probeVoice(provider: Provider): Promise<Pick<Capabilities, "voice" | "voiceMessage">> {
  if (!provider.voiceModel || provider.kind === "anthropic" || provider.kind === "a1111") return {};
  try {
    await speak(provider, { text: "OK." });
    return { voice: true };
  } catch (err) {
    return { voice: false, voiceMessage: err instanceof Error ? err.message : String(err) };
  }
}
