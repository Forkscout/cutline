/**
 * The page's side of AI services. The server holds the keys and makes every
 * call; this only asks it to.
 */

import type { Transcript } from "@/editor/transcript";
import { apiJson } from "./server";

export interface ProviderReport {
  id: string;
  name: string;
  baseUrl: string;
  transcribeModel: string;
  hasKey: boolean;
  /** On this machine, so nothing leaves it. */
  local: boolean;
  capabilities?: {
    checkedAt: number;
    reachable: boolean;
    models: string[];
    transcribe: boolean;
    message?: string;
  };
}

export interface Capabilities {
  transcribe: { providerId: string; name: string; model: string; local: boolean } | null;
}

export const listProviders = () => apiJson<ProviderReport[]>("/api/ai/providers");
export const capabilities = () => apiJson<Capabilities>("/api/ai/capabilities");

/**
 * Adds or edits a provider, and answers with what it can do. Leave `apiKey`
 * undefined to keep a stored key; an empty string removes it.
 */
export function saveProvider(
  id: string,
  provider: { name: string; baseUrl: string; transcribeModel?: string; apiKey?: string },
): Promise<ProviderReport> {
  return apiJson<ProviderReport>(`/api/ai/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(provider),
  });
}

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
