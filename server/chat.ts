/**
 * The Director's model calls, whatever service runs the model.
 *
 * The page speaks one shape (`src/lib/chat-protocol.ts`) and this translates
 * it: Anthropic's Messages API for Claude direct, OpenAI's chat completions
 * for everything else — OpenAI, OpenRouter, LM Studio, any compatible server.
 * As with transcription the server makes every call and holds every key; the
 * page never sees one.
 *
 * Every call is logged to `~/Cutline/usage.jsonl` — tokens in and out, by
 * provider, model and project — so what the Director costs can be read on this
 * machine, not only on a provider's invoice.
 */

import { appendFile } from "node:fs/promises";
import type { ChatBlock, ChatRequest, ChatResponse, ImagePart } from "../src/lib/chat-protocol";
import { authHeaders, endpoint, type Capabilities, type Provider } from "./ai";
import { probe } from "./stt";

/** A reply with a dozen tool calls takes a minute or two; ten is generous. */
const CHAT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = "2023-06-01";
const EPHEMERAL = { type: "ephemeral" } as const;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const detail = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    if (detail) return detail.slice(0, 300);
  } catch {
    // Not JSON: say what came back.
  }
  return text.replace(/\s+/g, " ").slice(0, 300) || "no detail";
}

async function post(provider: Provider, route: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(endpoint(provider, route), {
      method: "POST",
      headers: { ...authHeaders(provider), ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("Stopped.");
    throw new Error(`Could not reach ${provider.baseUrl} — is the service running? (${err instanceof Error ? err.message : String(err)})`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${provider.name} answered ${response.status}: ${errorDetail(text)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${provider.name} answered with something that is not JSON: ${text.slice(0, 120)}`);
  }
}

/** Anthropic refuses empty text blocks, and an empty reply can leave one. */
const nonEmpty = (b: ChatBlock) => b.type !== "text" || b.text.trim().length > 0;

/* --------------------------------------------------------- Anthropic */

interface AnthropicResponse {
  content?: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "thinking" | "redacted_thinking" })[];
  stop_reason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function anthropicBlock(block: ChatBlock): Json {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: isObject(block.input) ? block.input : {} };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        ...(block.isError ? { is_error: true } : {}),
        content: (block.content.length ? block.content : [{ type: "text" as const, text: "(no output)" }]).filter(nonEmpty).map(anthropicBlock),
      };
  }
}

async function anthropicChat(provider: Provider, model: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const messages = req.messages
    .map((m) => ({ role: m.role, content: m.content.filter(nonEmpty).map(anthropicBlock) }))
    .filter((m) => m.content.length > 0);
  // Every step of a turn sends the whole conversation again. A breakpoint on
  // the system prompt caches the tools too (they come first), and one on the
  // last block caches the conversation so far for the next step.
  const tail = messages.at(-1)?.content.at(-1);
  if (tail) tail.cache_control = EPHEMERAL;
  const body = {
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
    messages,
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
  };
  const json = (await post(provider, "messages", body, { "anthropic-version": ANTHROPIC_VERSION }, signal)) as AnthropicResponse;
  const content: ChatBlock[] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
  }
  const u = json.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  const stop = json.stop_reason;
  return {
    content,
    stopReason: stop === "tool_use" ? "tool_use" : stop === "max_tokens" ? "max_tokens" : stop === "end_turn" || stop === "stop_sequence" ? "end" : "other",
    usage: { inputTokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, cachedTokens: cached },
    model: json.model ?? model,
    provider: provider.name,
  };
}

/* ------------------------------------------------- OpenAI-compatible */

interface OpenAiResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  model?: string;
  /** OpenRouter can answer 200 with an error in the body. */
  error?: { message?: string } | string;
}

const imageUrl = (p: ImagePart): Json => ({ type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } });

function openAiMessages(provider: Provider, model: string, req: ChatRequest): Json[] {
  // Through OpenRouter a Claude model caches as it does direct, given a
  // breakpoint; the tools come before the system prompt, so one covers both.
  const openRouter = provider.capabilities?.flavor === "openrouter" || hostOf(provider.baseUrl).endsWith("openrouter.ai");
  const cache = openRouter && model.startsWith("anthropic/");
  const out: Json[] = [{ role: "system", content: cache ? [{ type: "text", text: req.system, cache_control: EPHEMERAL }] : req.system }];
  for (const m of req.messages) {
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const calls = m.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: b.invalidJson ?? JSON.stringify(b.input ?? {}) } }] : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const images: Json[] = [];
    const parts: Json[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const text = b.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
        const pictures = b.content.filter((c): c is ImagePart => c.type === "image");
        images.push(...pictures.map(imageUrl));
        out.push({
          role: "tool",
          tool_call_id: b.toolUseId,
          content: `${b.isError ? "Error: " : ""}${text || (pictures.length ? "(the image follows)" : "(no output)")}`,
        });
      } else if (b.type === "text" && b.text.trim()) parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push(imageUrl(b));
    }
    // A tool message carries text only, so pictures the tools returned follow as the user's.
    if (images.length) out.push({ role: "user", content: [{ type: "text", text: "The images the tool calls above returned, in order:" }, ...images] });
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

async function openAiChat(provider: Provider, model: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  // OpenAI's own newer models refuse max_tokens; everyone else still expects it.
  const limit =
    req.maxTokens === undefined ? {} : hostOf(provider.baseUrl) === "api.openai.com" ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens };
  const body = {
    model,
    messages: openAiMessages(provider, model, req),
    ...limit,
    ...(req.tools.length
      ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
      : {}),
  };
  const json = (await post(provider, "chat/completions", body, {}, signal)) as OpenAiResponse;
  if (json.error) throw new Error(`${provider.name}: ${typeof json.error === "string" ? json.error : (json.error.message ?? "error")}`);
  const choice = json.choices?.[0];
  if (!choice?.message) throw new Error(`${provider.name} answered without a message.`);
  const content: ChatBlock[] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  (choice.message.tool_calls ?? []).forEach((call, i) => {
    const raw = call.function?.arguments ?? "";
    const base = { type: "tool_use" as const, id: call.id || `call_${Date.now()}_${i}`, name: call.function?.name ?? "" };
    try {
      content.push({ ...base, input: raw.trim() ? JSON.parse(raw) : {} });
    } catch {
      content.push({ ...base, input: {}, invalidJson: raw });
    }
  });
  const u = json.usage ?? {};
  const finish = choice.finish_reason;
  return {
    content,
    stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : finish === "length" ? "max_tokens" : !finish || finish === "stop" ? "end" : "other",
    usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    model: json.model ?? model,
    provider: provider.name,
  };
}

/* ------------------------------------------------------------ public */

export function runChat(provider: Provider, req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const model = provider.chatModel;
  if (!model) return Promise.reject(new Error(`${provider.name} has no model chosen for the Director.`));
  return provider.kind === "anthropic" ? anthropicChat(provider, model, req, signal) : openAiChat(provider, model, req, signal);
}

/** Whether the chosen model answers at all, found by asking it for a word. */
export async function probeChat(provider: Provider): Promise<Pick<Capabilities, "chat" | "chatMessage">> {
  if (!provider.chatModel || provider.kind === "elevenlabs") return { chat: false };
  try {
    await runChat(provider, { system: "Answer in one word.", messages: [{ role: "user", content: [{ type: "text", text: "Say OK." }] }], tools: [], maxTokens: 16 });
    return { chat: true };
  } catch (err) {
    return { chat: false, chatMessage: err instanceof Error ? err.message : String(err) };
  }
}

/** Transcription and chat, each found by trying it. */
export async function probeAll(provider: Provider): Promise<Capabilities> {
  const [speech, chat] = await Promise.all([probe(provider), probeChat(provider)]);
  return { ...speech, reachable: speech.reachable || chat.chat === true, ...chat };
}

export async function recordUsage(file: string, entry: Record<string, unknown>): Promise<void> {
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
