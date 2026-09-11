/**
 * The AI services the user has connected, and what each can actually do.
 *
 * A provider is a name, an OpenAI-compatible base URL and an optional key —
 * OpenAI itself, Groq, a whisper.cpp server on this machine, LM Studio, Ollama.
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
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** The model name sent to /audio/transcriptions. */
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
  return provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
}

export function endpoint(provider: Provider, route: string): string {
  return `${provider.baseUrl.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
}

/** A quarter-second of 16 kHz mono silence as a WAV: the cheapest honest probe. */
function silentWav(seconds: number): Uint8Array {
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

/** Asks the service what it can do, by trying it. */
export async function probe(provider: Provider): Promise<Capabilities> {
  const headers = authHeaders(provider);
  let reachable = false;
  let models: string[] = [];
  try {
    const response = await fetch(endpoint(provider, "models"), { headers, signal: AbortSignal.timeout(5000) });
    reachable = true;
    if (response.ok) {
      const body = (await response.json()) as { data?: { id: string }[] };
      models = body.data?.map((m) => m.id) ?? [];
    }
  } catch {
    // Some transcription servers have no /models at all; the next request decides.
  }

  let transcribe = false;
  let message: string | undefined;
  try {
    const form = new FormData();
    form.set("file", new Blob([silentWav(0.25)], { type: "audio/wav" }), "probe.wav");
    form.set("model", provider.transcribeModel);
    form.set("response_format", "json");
    const response = await fetch(endpoint(provider, "audio/transcriptions"), {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    reachable = true;
    transcribe = response.ok;
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 160);
      message =
        response.status === 404 || response.status === 405
          ? `This service has no transcription endpoint (${response.status}).`
          : `Transcription failed: ${response.status} ${detail}`;
    }
  } catch (err) {
    message = reachable
      ? `Transcription did not answer: ${err instanceof Error ? err.message : String(err)}`
      : `Could not reach ${provider.baseUrl}.`;
  }

  return { checkedAt: Date.now(), reachable, models, transcribe, ...(message ? { message } : {}) };
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
      return { providers: parsed.providers ?? [] };
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
    patch: { name: string; baseUrl: string; transcribeModel?: string; apiKey?: string },
  ): Promise<Provider> {
    const data = await this.read();
    const existing = data.providers.find((p) => p.id === id);
    const next: Provider = {
      id,
      name: patch.name,
      baseUrl: patch.baseUrl.replace(/\/+$/, ""),
      transcribeModel: patch.transcribeModel || existing?.transcribeModel || "whisper-1",
    };
    const key = patch.apiKey === undefined ? existing?.apiKey : patch.apiKey;
    if (key) next.apiKey = key;
    data.providers = existing ? data.providers.map((p) => (p.id === id ? next : p)) : [...data.providers, next];
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

  /** The first connected provider that transcribes, in the order they were added. */
  async resolveTranscribe(): Promise<Provider | null> {
    return (await this.read()).providers.find((p) => p.capabilities?.transcribe) ?? null;
  }
}
