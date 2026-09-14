/**
 * Image generation, one adapter per kind of API: the image role.
 *
 * A prompt goes in and a still comes out, which the page imports like any
 * other picture. Two kinds of API cover what runs on a Mac and what is hosted:
 *
 * - OpenAI's images API: /images/generations on OpenAI and on local servers
 *   that speak it (stable-diffusion.cpp's sd-server, LocalAI), and OpenRouter's
 *   unified /images, which takes an aspect ratio rather than pixels.
 * - AUTOMATIC1111's /sdapi/v1/txt2img, which the Draw Things app serves on
 *   port 7860 when its API server is on, as do A1111, Forge and SD.Next. Draw
 *   Things draws with the model selected in the app and answers GET / with its
 *   settings, so a pinned model is checked before drawing rather than silently
 *   replaced by whatever the app has open.
 *
 * The seed is chosen here when none is given, sent, and recorded, so a still
 * can be drawn again or varied from what is written down.
 */

import { authHeaders, endpoint, type Capabilities, type Provider, type ProviderKind } from "./ai";

/** The largest image taken back, decoded. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

export class ImageTooLarge extends Error {}

/** 413 for an image too large to take, 422 for anything else a service got wrong — never 5xx, which the page reads as the server being down. */
export const imageStatus = (err: unknown): 413 | 422 => (err instanceof ImageTooLarge ? 413 : 422);

export interface ImageRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  sampler?: string;
}

type Mime = "image/png" | "image/jpeg" | "image/webp";

export interface Picture {
  bytes: Uint8Array;
  mime: Mime;
  /** From the PNG header, when it is one. */
  width?: number;
  height?: number;
  seed: number;
  /** The model asked for, or the one the app had selected when it was left to the app. */
  model: string;
  /** The model the service says it drew with, when it says. */
  modelUsed?: string;
}

interface Options {
  signal?: AbortSignal;
  maxBytes: number;
}

interface ImageAdapter {
  generate(provider: Provider, request: ImageRequest & { seed: number }, options: Options): Promise<Picture>;
}

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
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw new Error(`${provider.name} did not finish drawing in time.`);
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

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;

/**
 * A response body read within a limit: refused before reading when it says it
 * is bigger, and while reading when it turns out to be. Base64 is four
 * characters to three bytes, and JSON adds a little.
 */
async function bodyWithin(response: Response, maxBytes: number): Promise<string> {
  const allowed = Math.ceil((maxBytes * 4) / 3) + 64_000;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > allowed) throw new ImageTooLarge(`The image is about ${megabytes((declared * 3) / 4)}; ${megabytes(maxBytes)} is the most taken.`);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > allowed) {
      await reader.cancel().catch(() => {});
      throw new ImageTooLarge(`The image is more than ${megabytes(maxBytes)}, the most taken.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function sniff(bytes: Uint8Array): Mime | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

function pngSize(bytes: Uint8Array, mime: Mime): { width?: number; height?: number } {
  if (mime !== "image/png" || bytes.length < 24) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** An image from base64 or a data URL, or why it is not one. */
export function decodeImage(encoded: string, maxBytes: number): { bytes: Uint8Array; mime: Mime; width?: number; height?: number } {
  const b64 = encoded.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
  if (!b64 || b64.length % 4 === 1 || /[^A-Za-z0-9+/=_-]/.test(b64)) throw new Error("The service sent something that is not base64 image data.");
  if ((b64.length * 3) / 4 > maxBytes) throw new ImageTooLarge(`The image is about ${megabytes((b64.length * 3) / 4)}; ${megabytes(maxBytes)} is the most taken.`);
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const mime = sniff(bytes);
  if (!mime) throw new Error("The service sent data that is not a PNG, JPEG or WebP image.");
  return { bytes, mime, ...pngSize(bytes, mime) };
}

function parse(provider: Provider, text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${provider.name} answered with something that is not JSON: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

const errorIn = (json: Record<string, unknown>): string | null => {
  const error = json.error as string | { message?: string } | undefined;
  return !error ? null : typeof error === "string" ? error : (error.message ?? JSON.stringify(error));
};

/* ------------------------------------------------- OpenAI-compatible */

const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"];

/** The aspect ratio closest to a size, of those hosted services take. */
export function nearestRatio(width: number, height: number): string {
  const want = Math.log(width / height);
  const value = (r: string) => {
    const [a, b] = r.split(":").map(Number);
    return Math.log(a! / b!);
  };
  return RATIOS.reduce((best, r) => (Math.abs(value(r) - want) < Math.abs(value(best) - want) ? r : best));
}

/**
 * What an OpenAI-style service is sent for a request — exported for the check,
 * which has no OpenAI or OpenRouter to send it to. Hosted services take no
 * negative prompt, so it is said in words; OpenAI takes three sizes and no seed.
 */
export function openAiImageRequest(provider: Provider, model: string, request: ImageRequest & { seed: number }): { route: string; body: Record<string, unknown> } {
  const host = hostOf(provider);
  const worded = request.negativePrompt ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}` : request.prompt;
  if (host.endsWith("openrouter.ai")) {
    return { route: "images", body: { model, prompt: worded, n: 1, aspect_ratio: nearestRatio(request.width, request.height), seed: request.seed, output_format: "png" } };
  }
  if (host === "api.openai.com") {
    const ratio = request.width / request.height;
    const size = ratio > 1.2 ? "1536x1024" : ratio < 0.83 ? "1024x1536" : "1024x1024";
    return { route: "images/generations", body: { model, prompt: worded, n: 1, size, ...(model.startsWith("dall-e") ? { response_format: "b64_json" } : {}) } };
  }
  return {
    route: "images/generations",
    body: {
      model,
      prompt: request.prompt,
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      n: 1,
      size: `${request.width}x${request.height}`,
      seed: request.seed,
      ...(request.steps ? { steps: request.steps } : {}),
      ...(request.guidance !== undefined ? { cfg_scale: request.guidance } : {}),
      response_format: "b64_json",
    },
  };
}

const openai: ImageAdapter = {
  async generate(provider, request, options) {
    const model = provider.imageModel ?? "";
    const { route, body } = openAiImageRequest(provider, model, request);
    const response = await reach(provider, endpoint(provider, route), {
      method: "POST",
      headers: { ...authHeaders(provider), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok) throw await failure(provider, response, "draw");
    const json = parse(provider, await bodyWithin(response, options.maxBytes));
    const said = errorIn(json);
    if (said) throw new Error(`${provider.name}: ${said}`);
    const item = (json.data as { b64_json?: string; url?: string }[] | undefined)?.[0];
    if (item?.b64_json) return { ...decodeImage(item.b64_json, options.maxBytes), seed: request.seed, model };
    if (item?.url) {
      const got = await reach(provider, item.url, { signal: AbortSignal.timeout(60_000) });
      if (!got.ok) throw await failure(provider, got, "hand over the image");
      if (Number(got.headers.get("content-length") ?? 0) > options.maxBytes) throw new ImageTooLarge(`The image is more than ${megabytes(options.maxBytes)}, the most taken.`);
      const bytes = new Uint8Array(await got.arrayBuffer());
      if (bytes.byteLength > options.maxBytes) throw new ImageTooLarge(`The image is more than ${megabytes(options.maxBytes)}, the most taken.`);
      const mime = sniff(bytes);
      if (!mime) throw new Error(`${provider.name} linked to something that is not a PNG, JPEG or WebP image.`);
      return { bytes, mime, ...pngSize(bytes, mime), seed: request.seed, model };
    }
    throw new Error(`${provider.name} answered without an image.`);
  },
};

/* ------------------------------------------ AUTOMATIC1111 / Draw Things */

/** "current", or nothing, leaves the model to the app. */
export const followsApp = (model: string | undefined): boolean => !model || model.trim().toLowerCase() === "current";

/** The same model, path, extension, checkpoint hash and case aside: "z_image_turbo_1.0_q8p.ckpt" is "Z_Image_Turbo_1.0_q8p". */
export function sameModel(a: string, b: string): boolean {
  const key = (s: string) =>
    (s.toLowerCase().split(/[\\/]/).pop() ?? "")
      .replace(/\s*\[[0-9a-f]+\]$/, "")
      .replace(/\.(ckpt|safetensors|gguf|bin|pth)$/, "")
      .trim();
  return key(a) === key(b);
}

/**
 * The model an AUTOMATIC1111-style server has loaded. Draw Things answers GET /
 * with its current settings as JSON; A1111 serves its web page there and says
 * at /sdapi/v1/options. Null when neither says.
 */
export async function loadedModel(provider: Provider): Promise<{ model: string; drawThings: boolean } | null> {
  const read = async (route: string) => {
    const response = await fetch(endpoint(provider, route), { headers: authHeaders(provider), signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    try {
      return JSON.parse(await response.text()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  try {
    const config = await read("");
    if (config && typeof config.model === "string" && config.model) return { model: config.model, drawThings: true };
  } catch {
    // Not answering at / is not the same as not drawing; the options may say.
  }
  try {
    const options = await read("sdapi/v1/options");
    if (options && typeof options.sd_model_checkpoint === "string" && options.sd_model_checkpoint) return { model: options.sd_model_checkpoint, drawThings: false };
  } catch {
    // The drawing request decides.
  }
  return null;
}

const a1111: ImageAdapter = {
  async generate(provider, request, options) {
    const pinned = provider.imageModel;
    const loaded = await loadedModel(provider);
    let override: string | undefined;
    if (!followsApp(pinned) && !(loaded && sameModel(loaded.model, pinned!))) {
      // Draw Things cannot switch models by request, and drawing anyway would
      // put another model's picture into this look.
      if (loaded?.drawThings) {
        throw new Error(`${provider.name} has ${loaded.model} selected, but this asks for ${pinned}. Select ${pinned} in Draw Things, or change the look's model if the client agrees.`);
      }
      override = pinned;
    }
    const response = await reach(provider, endpoint(provider, "sdapi/v1/txt2img"), {
      method: "POST",
      headers: { ...authHeaders(provider), "content-type": "application/json" },
      body: JSON.stringify({
        prompt: request.prompt,
        negative_prompt: request.negativePrompt ?? "",
        width: request.width,
        height: request.height,
        seed: request.seed,
        batch_size: 1,
        n_iter: 1,
        ...(request.steps ? { steps: request.steps } : {}),
        ...(request.guidance !== undefined ? { cfg_scale: request.guidance } : {}),
        ...(request.sampler ? { sampler_name: request.sampler } : {}),
        ...(override ? { override_settings: { sd_model_checkpoint: override }, override_settings_restore_afterwards: false } : {}),
      }),
      // A large model on a laptop can take minutes, the first time especially.
      signal: options.signal ?? AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok) throw await failure(provider, response, "draw");
    const json = parse(provider, await bodyWithin(response, options.maxBytes));
    const first = (json.images as unknown[] | undefined)?.[0];
    if (typeof first !== "string") throw new Error(`${provider.name} answered without an image${errorIn(json) ? `: ${errorIn(json)}` : "."}`);
    const picture = decodeImage(first, options.maxBytes);
    // A1111 reports the seed it drew with in info, a JSON string.
    let seed = request.seed;
    try {
      const info = (typeof json.info === "string" ? JSON.parse(json.info) : json.info) as { seed?: unknown } | undefined;
      if (typeof info?.seed === "number" && Number.isInteger(info.seed) && info.seed >= 0) seed = info.seed;
    } catch {
      // No info: the seed sent is the record.
    }
    const used = override ?? loaded?.model;
    return { ...picture, seed, model: followsApp(pinned) ? (loaded?.model ?? "current") : pinned!, ...(used ? { modelUsed: used } : {}) };
  },
};

/* ------------------------------------------------------- the others */

const none = (what: string): ImageAdapter => ({
  async generate() {
    throw new Error(`${what} has no image generation. Give an image model to another service in Services.`);
  },
});

/* ------------------------------------------------------------ public */

const ADAPTERS: Record<ProviderKind, ImageAdapter> = { openai, a1111, elevenlabs: none("ElevenLabs"), anthropic: none("Anthropic") };

/** A still drawn from a prompt. The seed is chosen here when none is given, so it can be written down. */
export async function generateImage(provider: Provider, request: ImageRequest, options: Partial<Options> = {}): Promise<Picture> {
  if (!provider.imageModel) throw new Error(`${provider.name} has no image model chosen.`);
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("There is nothing to draw: the prompt is empty.");
  const whole = (n: number) => Number.isInteger(n) && n >= 64 && n <= 4096;
  if (!whole(request.width) || !whole(request.height)) throw new Error("Width and height must be whole pixels from 64 to 4096.");
  const seed = request.seed ?? Math.floor(Math.random() * 2 ** 31);
  return ADAPTERS[provider.kind].generate(provider, { ...request, prompt, seed }, { maxBytes: options.maxBytes ?? MAX_IMAGE_BYTES, ...(options.signal ? { signal: options.signal } : {}) });
}

/** Whether the chosen image model draws, found by having it draw a small one: free on this Mac, a fraction of a cent hosted. */
export async function probeImage(provider: Provider): Promise<Pick<Capabilities, "image" | "imageMessage">> {
  if (!provider.imageModel || provider.kind === "anthropic" || provider.kind === "elevenlabs") return {};
  try {
    await generateImage(provider, { prompt: "A red circle on a white background", width: 256, height: 256, seed: 1, ...(provider.kind === "a1111" ? { steps: 4 } : {}) });
    return { image: true };
  } catch (err) {
    return { image: false, imageMessage: err instanceof Error ? err.message : String(err) };
  }
}
