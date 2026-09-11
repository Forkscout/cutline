/**
 * The AI services the user has connected, and what each can actually do.
 *
 * A provider is a kind of API, a base URL and an optional key. Most services
 * speak OpenAI's — OpenAI itself, Groq, OpenRouter, a whisper.cpp server on
 * this machine — and ElevenLabs has its own; `stt.ts` has one adapter per kind.
 * Keys live in `~/Cutline/ai.json`, readable only by the user, and never go
 * back to the page: this server makes every call, so the browser never holds a
 * key and local services never see a cross-origin request.
 *
 * Adding a provider probes it rather than reporting "connected": a green tick
 * on an endpoint that cannot transcribe is how someone finds out at the
 * captions button that nothing works. LM Studio, as of September 2026, lists
 * models but has no transcription endpoint; the probe says so.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Capabilities {
  checkedAt: number;
  /** Anything answered at all. */
  reachable: boolean;
  models: string[];
  transcribe: boolean;
  /** Why transcription is unavailable, in the service's own words where possible. */
  message?: string;
  /**
   * An OpenAI-compatible service that needs handling of its own: whisper.cpp
   * (recognised by its Server header) and OpenRouter (by its host).
   */
  flavor?: "whisper.cpp" | "openrouter";
}

/** Which API the provider speaks; `stt.ts` has an adapter for each. */
export type ProviderKind = "openai" | "elevenlabs";

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** The model to transcribe with: whisper-1, openai/whisper-large-v3, scribe_v2. */
  transcribeModel: string;
  capabilities?: Capabilities;
}

/** What the page may see: everything but the key. */
export type PublicProvider = Omit<Provider, "apiKey"> & { hasKey: boolean; local: boolean };

/** A service on this machine, so nothing leaves it. */
export function isLocal(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export function authHeaders(provider: Provider): Record<string, string> {
  if (!provider.apiKey) return {};
  return provider.kind === "elevenlabs"
    ? { "xi-api-key": provider.apiKey }
    : { authorization: `Bearer ${provider.apiKey}` };
}

/** The model a kind of service is asked for when the user names none. */
export const DEFAULT_MODEL: Record<ProviderKind, string> = { openai: "whisper-1", elevenlabs: "scribe_v2" };

export function endpoint(provider: Provider, route: string): string {
  return `${provider.baseUrl.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
}

/** A quarter-second of 16 kHz mono silence as a WAV: the cheapest honest probe. */
export function silentWav(seconds: number): Uint8Array {
  const rate = 16_000;
  const samples = Math.round(rate * seconds);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
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
  view.setUint32(40, samples * 2, true);
  return bytes;
}

interface Stored {
  providers: Provider[];
}

export class AiSettings {
  private readonly file: string;

  constructor(home: string) {
    this.file = path.join(home, "ai.json");
  }

  private async read(): Promise<Stored> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<Stored>;
      // Providers saved before there was more than one kind spoke OpenAI's API.
      return { providers: (parsed.providers ?? []).map((p) => ({ ...p, kind: p.kind ?? "openai" })) };
    } catch {
      return { providers: [] };
    }
  }

  /** Written beside, renamed into place, readable only by the owner: it holds keys. */
  private async write(data: Stored): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${crypto.randomUUID()}.part`;
    await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  private toPublic({ apiKey, ...rest }: Provider): PublicProvider {
    return { ...rest, hasKey: Boolean(apiKey), local: isLocal(rest.baseUrl) };
  }

  async list(): Promise<PublicProvider[]> {
    return (await this.read()).providers.map((p) => this.toPublic(p));
  }

  async get(id: string): Promise<Provider | null> {
    return (await this.read()).providers.find((p) => p.id === id) ?? null;
  }

  /**
   * Creates or updates a provider. An `apiKey` of undefined keeps the stored
   * one, so the page can edit a provider without ever having seen its key; an
   * empty string removes it.
   */
  async upsert(
    id: string,
    patch: { kind?: ProviderKind; name: string; baseUrl: string; transcribeModel?: string; apiKey?: string },
  ): Promise<Provider> {
    const data = await this.read();
    const existing = data.providers.find((p) => p.id === id);
    const kind = patch.kind ?? existing?.kind ?? "openai";
    const next: Provider = {
      id,
      kind,
      name: patch.name,
      baseUrl: patch.baseUrl.replace(/\/+$/, ""),
      transcribeModel: patch.transcribeModel || existing?.transcribeModel || DEFAULT_MODEL[kind],
    };
    const key = patch.apiKey === undefined ? existing?.apiKey : patch.apiKey;
    if (key) next.apiKey = key;
    // The service connected last is the one used: connecting OpenRouter after a
    // local server means "use OpenRouter now". It used to mean nothing at all —
    // the first one added kept answering.
    data.providers = [next, ...data.providers.filter((p) => p.id !== id)];
    await this.write(data);
    return next;
  }

  async setCapabilities(id: string, capabilities: Capabilities): Promise<PublicProvider | null> {
    const data = await this.read();
    const provider = data.providers.find((p) => p.id === id);
    if (!provider) return null;
    provider.capabilities = capabilities;
    await this.write(data);
    return this.toPublic(provider);
  }

  async remove(id: string): Promise<void> {
    const data = await this.read();
    data.providers = data.providers.filter((p) => p.id !== id);
    await this.write(data);
  }

  /** The most recently connected provider that can transcribe. */
  async resolveTranscribe(): Promise<Provider | null> {
    return (await this.read()).providers.find((p) => p.capabilities?.transcribe) ?? null;
  }
}
