/**
 * Talking to the local Cutline server.
 *
 * The token arrives in a `<meta>` tag the server (or the dev server) writes
 * into the page. A foreign website cannot read another origin's HTML, so it
 * cannot learn the token — which is the whole of the check that stops an
 * arbitrary page from writing to the user's disk through this server.
 */

export class ServerUnavailable extends Error {
  constructor() {
    super("The Cutline server is not running. Start it with `bun run dev`.");
    this.name = "ServerUnavailable";
  }
}

/** Empty inside a worker, where there is no document; the cookie covers it. */
function token(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="cutline-token"]')?.getAttribute("content") ?? "";
}

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const secret = token();
  if (secret) headers.set("x-cutline-token", secret);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ServerUnavailable();
  }
  // The dev proxy answers 5xx when there is nothing behind it. Saying "server
  // not running" is actionable; a bare 502 is not.
  if (response.status >= 502 && response.status <= 504) throw new ServerUnavailable();
  return response;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await api(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Not JSON; the status line is the best there is.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function serverAvailable(): Promise<boolean> {
  try {
    return (await api("/api/health")).ok;
  } catch {
    return false;
  }
}

let session: Promise<boolean> | null = null;

/**
 * Exchanges the page's token for the session cookie that media requests need.
 *
 * Must finish before anything renders a `<video>` pointing at the server, or
 * the first media request goes out without credentials. Resolves false rather
 * than throwing when the server is down, because recording still works then.
 */
export function startSession(): Promise<boolean> {
  session ??= api("/api/session", { method: "POST" })
    .then((r) => r.ok)
    .catch(() => false)
    .then((ok) => {
      if (!ok) session = null; // Try again next time rather than caching a failure.
      return ok;
    });
  return session;
}

/** Whether the server is up but refuses this page's token: it restarted, with a new one, since the page loaded. */
export async function tokenRefused(): Promise<boolean> {
  try {
    return (await fetch("/api/health", { headers: { "x-cutline-token": token() } })).status === 401;
  } catch {
    return false;
  }
}

/**
 * Picks up the token of a server that restarted since the page loaded. Each run
 * of the server has its own, so after a restart every call from an open page
 * is refused and its bridge retried in silence. The page reads the new token
 * from its own HTML — the way it got the first; another origin cannot read it —
 * and trades it for a fresh session cookie. False when that did not work.
 */
export async function refreshSession(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  try {
    const html = await (await fetch("/", { cache: "no-store" })).text();
    const fresh = new DOMParser().parseFromString(html, "text/html").querySelector('meta[name="cutline-token"]')?.getAttribute("content");
    if (!fresh) return false;
    document.querySelector('meta[name="cutline-token"]')?.setAttribute("content", fresh);
    session = null;
    return await startSession();
  } catch {
    return false;
  }
}
