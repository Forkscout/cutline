/**
 * The page's side of AI services. The server holds the keys and makes every
 * call; this only asks it to.
 */

import type { Transcript } from "@/editor/transcript";
import type { ChatRequest, ChatResponse } from "./chat-protocol";
import { apiJson } from "./server";

/** Which API a provider speaks: OpenAI's (OpenAI, Groq, OpenRouter, whisper.cpp…), ElevenLabs' or Anthropic's. */
export type ProviderKind = "openai" | "elevenlabs" | "anthropic";

export interface ProviderReport {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  transcribeModel: string;
  /** The model the Director runs on, when it is used for that. */
  chatModel?: string;
  hasKey: boolean;
  /** On this machine, so nothing leaves it. */
  local: boolean;
  capabilities?: {
    checkedAt: number;
    reachable: boolean;
    models: string[];
    transcribe: boolean;
    message?: string;
    flavor?: "whisper.cpp" | "openrouter";
    chat?: boolean;
    chatMessage?: string;
  };
}

export interface ServiceInUse {
  providerId: string;
  kind: ProviderKind;
  name: string;
  model: string;
  local: boolean;
}

export interface Capabilities {
  transcribe: ServiceInUse | null;
  /** The model the Director runs on. */
  chat?: ServiceInUse | null;
}

export const listProviders = () => apiJson<ProviderReport[]>("/api/ai/providers");
export const capabilities = () => apiJson<Capabilities>("/api/ai/capabilities");

/**
 * Adds or edits a provider, and answers with what it can do. Leave `apiKey`
 * undefined to keep a stored key; an empty string removes it.
 */
export function saveProvider(
  id: string,
  provider: { kind?: ProviderKind; name: string; baseUrl: string; transcribeModel?: string; chatModel?: string; apiKey?: string },
): Promise<ProviderReport> {
  return apiJson<ProviderReport>(`/api/ai/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(provider),
  });
}

/** Asks the service again what it can do, without changing anything. */
export const probeProvider = (id: string) =>
  apiJson<ProviderReport>(`/api/ai/providers/${encodeURIComponent(id)}/probe`, { method: "POST" });

export async function removeProvider(id: string): Promise<void> {
  await apiJson(`/api/ai/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export type TranscribeTarget = { sessionId: string; fileName: string } | { mediaId: string };

/** Transcribes one file, reporting progress while the server works. */
export async function transcribe(
  target: TranscribeTarget,
  options: { language?: string; force?: boolean } = {},
  onProgress?: (fraction: number, note: string) => void,
): Promise<Transcript> {
  const { jobId } = await apiJson<{ jobId: string }>("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...target, ...options }),
  });
  for (;;) {
    const job = await apiJson<{ status: string; progress: number; note: string; result?: Transcript; error?: string }>(
      `/api/transcribe/${jobId}`,
    );
    if (job.status === "done" && job.result) return job.result;
    if (job.status === "error") throw new Error(job.error ?? "Transcription failed.");
    onProgress?.(job.progress, job.note);
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

/**
 * One model call for the Director, through the server, which holds the key.
 * Aborting stops the call on the server too, so a long reply is not paid for
 * to the end.
 */
export async function chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const { jobId } = await apiJson<{ jobId: string }>("/api/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const stop = () => void apiJson(`/api/ai/chat/${jobId}`, { method: "DELETE" }).catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      const job = await apiJson<{ status: string; result?: ChatResponse; error?: string }>(`/api/ai/chat/${jobId}`);
      if (job.status === "done" && job.result) return job.result;
      if (job.status === "error") throw new Error(job.error ?? "The model call failed.");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
