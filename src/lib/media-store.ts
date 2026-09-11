/**
 * Recordings and imported media, on the local server.
 *
 * Two ways in. Whole-file reads and writes go through `api()` with the token
 * header. Playback, thumbnails and the exporter read through plain URLs —
 * `<video>` and mediabunny's `UrlSource` cannot add headers, so they rely on the
 * session cookie from `startSession`, and the server answers them with byte
 * ranges rather than whole files.
 */

import type { StreamTargetChunk } from "mediabunny";
import type { SessionMeta } from "@/recorder/types";
import { api, apiJson } from "./server";

const enc = encodeURIComponent;

export function sessionFileUrl(sessionId: string, fileName: string): string {
  return `/api/recordings/${enc(sessionId)}/files/${enc(fileName)}`;
}

export function mediaFileUrl(fileId: string): string {
  return `/api/media/${enc(fileId)}`;
}

/* ------------------------------------------------------------------- sizes */

/**
 * Size by HEAD, or null when the file does not exist.
 *
 * Read from `x-file-size` rather than `content-length`: a HEAD response has no
 * body, and a runtime is within its rights to report the length of the body it
 * actually sent, which is zero. The sync step deletes local copies on the
 * strength of this number, so it has to be the file's.
 */
async function headSize(url: string): Promise<number | null> {
  const response = await api(url, { method: "HEAD" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not check ${url} (${response.status}).`);
  return Number(response.headers.get("x-file-size") ?? response.headers.get("content-length") ?? "0");
}

export const sessionFileSize = (sessionId: string, fileName: string) =>
  headSize(sessionFileUrl(sessionId, fileName));
export const mediaFileSize = (fileId: string) => headSize(mediaFileUrl(fileId));

export async function sessionFileExists(sessionId: string, fileName: string): Promise<boolean> {
  return (await sessionFileSize(sessionId, fileName)) !== null;
}

export async function mediaFileExists(fileId: string): Promise<boolean> {
  return (await mediaFileSize(fileId)) !== null;
}

/* ------------------------------------------------------------------ reads */

async function fetchFile(url: string, name: string): Promise<File> {
  const response = await api(url);
  if (!response.ok) throw new Error(`Could not read ${name} (${response.status}).`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

/**
 * The whole file, in memory. Only for callers that genuinely need every byte —
 * `decodeAudioData` is the main one. Anything that can read through a URL
 * should, because a two-hour recording is several gigabytes.
 */
export const getTrackFile = (sessionId: string, fileName: string) =>
  fetchFile(sessionFileUrl(sessionId, fileName), fileName);
export const getMediaFile = (fileId: string) => fetchFile(mediaFileUrl(fileId), fileId);

export async function listSessions(): Promise<SessionMeta[]> {
  return apiJson<SessionMeta[]>("/api/recordings");
}

/* ----------------------------------------------------------------- writes */

/**
 * Uploads, then insists the server wrote exactly what was sent. The browser
 * sends a length for Blob and ArrayBuffer bodies, and the server refuses a
 * short body — this is the second half of that check.
 */
async function put(url: string, body: Blob | ArrayBuffer): Promise<void> {
  const size = body instanceof Blob ? body.size : body.byteLength;
  const result = await apiJson<{ bytes: number }>(url, { method: "PUT", body });
  if (result.bytes !== size) {
    throw new Error(`Upload of ${url} wrote ${result.bytes} of ${size} bytes.`);
  }
}

export const writeSessionFile = (sessionId: string, fileName: string, data: Blob | ArrayBuffer) =>
  put(sessionFileUrl(sessionId, fileName), data);
export const writeMediaFile = (fileId: string, data: Blob | ArrayBuffer) => put(mediaFileUrl(fileId), data);

/**
 * Asks the server to remux a take's file into an indexed copy.
 *
 * True when done. False when the server cannot do it — one without the route,
 * or down — so the page can. Throws when the file itself is empty or
 * unreadable: the page would fail on it the same way, and retrying there only
 * turned the real reason into a confusing range error.
 */
export async function remuxOnServer(sessionId: string, from: string, to: string): Promise<boolean> {
  let response: Response;
  try {
    response = await api(`/api/recordings/${enc(sessionId)}/remux`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  } catch {
    return false;
  }
  if (response.ok) return true;
  if (response.status === 422) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${from} could not be read.`);
  }
  return false;
}

/**
 * A sink for mediabunny's `StreamTarget` that uploads each chunk at its byte
 * position, so a file the page produces never has to be held whole. `done`
 * settles once the server has moved the finished file into place.
 */
export function positionalUpload(url: string): {
  writable: WritableStream<StreamTargetChunk>;
  done: Promise<void>;
} {
  const upload = crypto.randomUUID();
  let settle!: { resolve: () => void; reject: (reason: unknown) => void };
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const put = async (query: string, body: Blob) => {
    const response = await api(`${url}?upload=${upload}&${query}`, { method: "PUT", body });
    if (!response.ok) throw new Error(`Upload of ${url} failed (${response.status}).`);
  };
  const writable = new WritableStream<StreamTargetChunk>({
    // Copied into a Blob: the muxer may reuse the buffer behind this view.
    write: (chunk) => put(`at=${chunk.position}`, new Blob([chunk.data.slice()])),
    close: async () => {
      try {
        await put("at=0&final=1", new Blob([]));
        settle.resolve();
      } catch (err) {
        settle.reject(err);
        throw err;
      }
    },
    abort: (reason) => settle.reject(reason),
  });
  return { writable, done };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await apiJson(`/api/recordings/${enc(sessionId)}`, { method: "DELETE" });
}

export async function deleteMediaFile(fileId: string): Promise<void> {
  await apiJson(mediaFileUrl(fileId), { method: "DELETE" });
}

/* ------------------------------------------------------------------ usage */

export interface StorageUsage {
  usage: number;
  quota: number;
}

/** Bytes this workspace uses on disk, and what the disk could still hold. */
export async function estimateUsage(): Promise<StorageUsage> {
  return apiJson<StorageUsage>("/api/usage");
}
