/**
 * Questions from the agent to the client, asked in the editor they are
 * already watching.
 *
 * MCP has its own way for a server to ask the user something (elicitation),
 * but it needs a session held open between client and server, and Cutline's
 * MCP server is stateless on purpose — a restart under `bun --watch` must not
 * strand anyone. The editor tab, though, is always there: the agent's
 * ask_client puts a form in it, and the answers come back as the tool's result.
 *
 * Lives on globalThis so a hot reload of this module keeps the open form and
 * the promise waiting on it.
 */

export interface ClientQuestion {
  id: string;
  question: string;
  kind: "text" | "choice" | "multi";
  options: string[];
  /** A default the client can accept as it is. */
  suggested: string | null;
  /** Why the agent is asking — shown under the question. */
  why: string | null;
}

export interface QuestionRequest {
  id: string;
  title: string;
  questions: ClientQuestion[];
}

export type Settled = { status: "answered"; answers: Record<string, string | string[]> } | { status: "declined" };

interface State {
  open: { request: QuestionRequest; key: string; promise: Promise<Settled>; resolve: (s: Settled) => void } | null;
  listeners: Set<() => void>;
}
const state = ((globalThis as { __cutlineClientQuestions?: State }).__cutlineClientQuestions ??= { open: null, listeners: new Set() });

const notify = () => state.listeners.forEach((l) => l());

/** Opens the form, or joins the one already open with the same questions. */
export function askClient(title: string, questions: ClientQuestion[]): Promise<Settled> {
  const key = JSON.stringify(questions.map((q) => [q.question, q.options]));
  if (state.open?.key === key) return state.open.promise;
  // A different form replaces the open one, which counts as not answered.
  state.open?.resolve({ status: "declined" });
  let resolve!: (s: Settled) => void;
  const promise = new Promise<Settled>((r) => (resolve = r));
  state.open = { request: { id: crypto.randomUUID(), title, questions }, key, promise, resolve };
  notify();
  return promise;
}

export function settle(requestId: string, settled: Settled): void {
  if (state.open?.request.id !== requestId) return;
  state.open.resolve(settled);
  state.open = null;
  notify();
}

export function subscribe(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export const openRequest = (): QuestionRequest | null => state.open?.request ?? null;
