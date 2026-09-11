/**
 * The recorder page's side of the cursor track.
 *
 * The server does the sampling — only it can see the cursor while the user is
 * in another app. The page's job is to say when the take starts, pauses,
 * resumes and ends, on the same clock the tracks use.
 *
 * Best-effort by design. The recorder writes to OPFS precisely so that a take
 * never depends on the server; a missing server, or a platform the sampler
 * does not support yet, costs the take its cursor track and nothing else.
 */

import type { CursorCaptureInfo, FromCursor, ToCursor } from "./cursor-protocol";

/** Wall-clock ms on the same base as the session clock's origin. */
const wallNow = () => performance.timeOrigin + performance.now();

export class CursorCapture {
  private constructor(private ws: WebSocket) {}

  private send(message: ToCursor): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** Resolves null, never throws, when there will be no cursor track. */
  static start(sessionId: string, originWall: number, capture: CursorCaptureInfo): Promise<CursorCapture | null> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/cursor`);
      } catch {
        resolve(null);
        return;
      }
      const give = (value: CursorCapture | null) => {
        clearTimeout(timer);
        if (!value) ws.close();
        resolve(value);
      };
      const timer = setTimeout(() => give(null), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "start", sessionId, originWall, capture } satisfies ToCursor));
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as FromCursor;
        if (message.type === "started") give(new CursorCapture(ws));
        else if (message.type === "error") {
          console.info(`No cursor track for this take: ${message.message}`);
          give(null);
        }
      };
      ws.onerror = () => give(null);
    });
  }

  pause(): void {
    this.send({ type: "pause", wall: wallNow() });
  }

  resume(): void {
    this.send({ type: "resume", wall: wallNow() });
  }

  /** Ends the track — or deletes it, for a discarded take. Resolves the sample count. */
  stop(discard = false): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws.close();
        resolve(null);
      }, 5000);
      this.ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as FromCursor;
        if (message.type !== "stopped" && message.type !== "error") return;
        clearTimeout(timer);
        this.ws.close();
        resolve(message.type === "stopped" ? message.samples : null);
      };
      this.send({ type: discard ? "discard" : "stop" });
    });
  }
}
