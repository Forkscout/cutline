/**
 * The page's side of AI services. The server holds the keys and makes every
 * call; this only asks it to.
 */

import type { Transcript } from "@/editor/transcript";
import type { ChatRequest, ChatResponse } from "./chat-protocol";
import { api, apiJson } from "./server";

/** Which API a provider speaks: OpenAI's (OpenAI, Groq, OpenRouter, whisper.cpp…), ElevenLabs' or Anthropic's. */
export type ProviderKind = "openai" | "elevenlabs" | "anthropic";

/** What a service is used for. */
export type ServiceRole = "transcribe" | "chat" | "voice" | "image" | "video";

export const SERVICE_ROLES: ServiceRole[] = ["transcribe", "chat", "voice", "image", "video"];

/** What each role is, and whether anything here uses it yet. */
export const ROLES: Record<ServiceRole, { title: string; blurb: string; used: boolean }> = {
  transcribe: { title: "Speech to text", blurb: "Captions, and the transcript every graphic is timed to.", used: true },
  chat: { title: "Language model", blurb: "The Director: it reads the project, plans the edit and makes it.", used: true },
  voice: { title: "Voice", blurb: "Text to speech: voiceovers read from a script, placed on the timeline.", used: true },
  image: { title: "Images", blurb: "Generated stills. Saved for when Cutline makes them; nothing uses it yet.", used: false },
  video: { title: "Video", blurb: "Generated shots. Saved for when Cutline makes them; nothing uses it yet.", used: false },
};

export interface ProviderReport {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  transcribeModel: string;
  /** The model the Director runs on, when it is used for that. */
  chatModel?: string;
  voiceModel?: string;
  imageModel?: string;
  videoModel?: string;
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
    voice?: boolean;
    voiceMessage?: string;
  };
}

export interface ServiceInUse {
  providerId: string;
  kind: ProviderKind;
  name: string;
  model: string;
  local: boolean;
}

/** What each role falls back to when a project names nothing of its own. */
export type Capabilities = { [K in ServiceRole]?: ServiceInUse | null } & { transcribe: ServiceInUse | null };

export const listProviders = () => apiJson<ProviderReport[]>("/api/ai/providers");

/** The model a service would use for a role, whatever the record calls it. */
export const modelOf = (p: ProviderReport, role: ServiceRole): string | undefined =>
  role === "transcribe" ? p.transcribeModel : role === "chat" ? p.chatModel : role === "voice" ? p.voiceModel : role === "image" ? p.imageModel : p.videoModel;

/** Whether a service can fill a role: what the probe found, or — for what nothing calls yet — that a model is written down. */
export const canDo = (p: ProviderReport, role: ServiceRole): boolean =>
  Boolean(modelOf(p, role)) &&
  (role === "transcribe"
    ? Boolean(p.capabilities?.transcribe)
    : role === "chat"
      ? Boolean(p.capabilities?.chat)
      : role === "voice"
        ? p.capabilities?.voice !== false
        : true);
export const capabilities = () => apiJson<Capabilities>("/api/ai/capabilities");

/**
 * Adds or edits a provider, and answers with what it can do. Leave `apiKey`
 * undefined to keep a stored key; an empty string removes it.
 */
export function saveProvider(
  id: string,
  provider: {
    kind?: ProviderKind;
    name: string;
    baseUrl: string;
    transcribeModel?: string;
    chatModel?: string;
    voiceModel?: string;
    imageModel?: string;
    videoModel?: string;
    apiKey?: string;
  },
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

/**
 * The service a role uses here: the project's own choice when it can do the
 * job, and the workspace's otherwise — the same rule the server follows, so
 * the interface never names one service while another does the work.
 */
export async function serviceFor(role: ServiceRole, preferred?: string): Promise<ServiceInUse | null> {
  if (preferred) {
    const chosen = (await listProviders().catch(() => [])).find((p) => p.id === preferred);
    const model = chosen ? modelOf(chosen, role) : undefined;
    if (chosen && model && canDo(chosen, role)) {
      return { providerId: chosen.id, kind: chosen.kind, name: chosen.name, model, local: chosen.local };
    }
  }
  const fallback = await capabilities().catch(() => ({ transcribe: null }) as Capabilities);
  return fallback[role] ?? null;
}

export interface VoiceList {
  providerId: string;
  name: string;
  model: string;
  voices: { id: string; name: string }[];
}

/** The voices a service's voice model speaks: the project's choice, or the workspace's. */
export const listVoices = (providerId?: string) =>
  apiJson<VoiceList>(`/api/ai/voices${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}`);

export interface SpokenAudio {
  file: File;
  voice: string;
  model: string;
  provider: string;
}

/** Has the voice service read `text` aloud, and answers with the audio as a file to import. */
export async function speak(
  request: { text: string; voice?: string; speed?: number; instructions?: string; providerId?: string; projectId?: string },
  name = "Voice",
): Promise<SpokenAudio> {
  const response = await api("/api/ai/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Not JSON; the status line is the best there is.
    }
    throw new Error(message);
  }
  const mime = response.headers.get("content-type") ?? "audio/mpeg";
  const header = (key: string) => decodeURIComponent(response.headers.get(key) ?? "");
  const file = new File([await response.blob()], `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Voice"}.${mime.includes("wav") ? "wav" : "mp3"}`, { type: mime });
  return { file, voice: header("x-voice"), model: header("x-model"), provider: header("x-provider") };
}

export type TranscribeTarget = { sessionId: string; fileName: string } | { mediaId: string };

/** Transcribes one file, reporting progress while the server works. */
export async function transcribe(
  target: TranscribeTarget,
  options: { language?: string; force?: boolean; providerId?: string } = {},
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
