/**
 * The Director's conversation with a model, in one shape whatever service
 * runs it. The page builds it; `server/chat.ts` translates it to Anthropic's
 * Messages API or OpenAI's chat completions, and back. It is close to
 * Anthropic's shape on purpose: tool calls and their results are blocks inside
 * the messages, the more precise of the two.
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  mimeType: string;
  /** Base64, no data: prefix. */
  data: string;
}

export type ToolResultPart = TextPart | ImagePart;

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  /** Arguments that did not parse, kept so the Director can say so instead of running the tool with none. */
  invalidJson?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: ToolResultPart[];
  isError?: boolean;
}

export type ChatBlock = TextPart | ImagePart | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: ChatBlock[];
}

export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, an object schema. */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ChatTool[];
  maxTokens?: number;
  /** For the usage log: what the tokens were spent on. */
  projectId?: string;
}

export interface ChatUsage {
  /** Everything read, cached or not. */
  inputTokens: number;
  outputTokens: number;
  /** The part of inputTokens served from the provider's prompt cache. */
  cachedTokens: number;
}

export interface ChatResponse {
  content: ChatBlock[];
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage: ChatUsage;
  model: string;
  provider: string;
}
