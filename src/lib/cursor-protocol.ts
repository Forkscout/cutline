/**
 * Messages over `/api/cursor`, between the recorder page and the server that
 * samples the cursor. Types only: the server imports this file too.
 */

/** What the page can tell about the captured surface, from the track's settings. */
export interface CursorCaptureInfo {
  surface?: string;
  width?: number;
  height?: number;
}

/** Page to server. Every time is wall-clock ms (`performance.timeOrigin + now`). */
export type ToCursor =
  | { type: "start"; sessionId: string; originWall: number; capture: CursorCaptureInfo }
  | { type: "pause"; wall: number }
  | { type: "resume"; wall: number }
  | { type: "stop" }
  | { type: "discard" };

/** Server to page. */
export type FromCursor =
  | { type: "started" }
  | { type: "stopped"; samples: number }
  | { type: "error"; message: string };
