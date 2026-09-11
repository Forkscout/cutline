/**
 * The local server listens on a port, and that is attack surface even on
 * localhost.
 *
 * Any website the user has open can send requests to `127.0.0.1:<port>`, and
 * with DNS rebinding it can make them look same-origin. This server can write
 * files and, once rendering lands, run code — so three checks, all required:
 *
 *  - **Host** must name this machine. A rebinding attack arrives with the
 *    attacker's hostname in Host, which is what gives it away.
 *  - **Origin**, when the browser sends one, must be the app's own.
 *  - **A per-run token** in `x-cutline-token`. It is injected into the app's
 *    HTML and never served to anyone else, so a foreign page cannot read it.
 *
 * This is also the seam where real authentication goes if Cutline is ever
 * hosted: one middleware, rather than checks scattered through the routes.
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export interface GuardOptions {
  token: string;
  /** host:port pairs this server answers to. */
  allowedHosts: string[];
  /** Full origins allowed to call it from a browser. */
  allowedOrigins: string[];
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on unequal lengths, and returning early on length
  // leaks only the length, which for a fixed-size token is public anyway.
  return left.length === right.length && timingSafeEqual(left, right);
}

export function localhostPairs(...ports: number[]): string[] {
  return ports.flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`]);
}

/**
 * Host only, for routes that must work without the token — the page that
 * delivers the token being the obvious one. Still refuses a rebound hostname,
 * which is the attack that would otherwise read the token out of that page.
 */
export function hostGuard(allowedHosts: string[]): MiddlewareHandler {
  const hosts = new Set(allowedHosts);
  return async (c, next) => {
    if (!hosts.has(c.req.header("host") ?? "")) {
      return c.json({ error: "Host not allowed" }, 403);
    }
    await next();
  };
}

export function guard(options: GuardOptions): MiddlewareHandler {
  const hosts = new Set(options.allowedHosts);
  const origins = new Set(options.allowedOrigins);

  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!hosts.has(host)) {
      return c.json({ error: "Host not allowed" }, 403);
    }

    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) {
      return c.json({ error: "Origin not allowed" }, 403);
    }

    const token = c.req.header("x-cutline-token") ?? "";
    if (!sameSecret(token, options.token)) {
      return c.json({ error: "Missing or wrong token" }, 401);
    }

    await next();
  };
}
