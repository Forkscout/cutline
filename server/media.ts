/**
 * Recordings and imported media, on disk.
 *
 * Laid out under the same workspace root as projects:
 *
 *   workspaces/<ws>/recordings/<sessionId>/meta.json
 *   workspaces/<ws>/recordings/<sessionId>/screen.webm, screen.edit.webm, …
 *   workspaces/<ws>/media/<assetId>
 *
 * A recording is listed only once its `meta.json` exists. The client uploads
 * that file last, so a half-uploaded take never appears in the library looking
 * complete.
 */

import { mkdir, readdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { assertSafeId, BadId } from "./store";

/**
 * File names inside a recording directory: `screen.webm`, `camera.edit.webm`,
 * `screen.proxy.webm`, `meta.json`. No separators, no leading dot, no `..`.
 */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name) || name.includes("..")) throw new BadId(name);
}

/** Media ids are asset ids, optionally with a `.proxy` suffix. */
function assertSafeMediaId(id: string): void {
  assertSafeName(id);
}

export class TruncatedUpload extends Error {
  constructor(expected: number, got: number) {
    super(`Upload truncated: expected ${expected} bytes, received ${got}`);
  }
}

export class DiskMediaStore {
  private readonly recordings: string;
  private readonly media: string;
  private readonly exports: string;
  readonly workspaceDir: string;

  constructor(root: string, workspaceId: string) {
    assertSafeId(workspaceId);
    this.workspaceDir = path.join(root, "workspaces", workspaceId);
    this.recordings = path.join(this.workspaceDir, "recordings");
    this.media = path.join(this.workspaceDir, "media");
    this.exports = path.join(this.workspaceDir, "exports");
  }

  recordingFile(sessionId: string, name: string): string {
    assertSafeId(sessionId);
    assertSafeName(name);
    return path.join(this.recordings, sessionId, name);
  }

  mediaFile(id: string): string {
    assertSafeMediaId(id);
    return path.join(this.media, id);
  }

  exportFile(name: string): string {
    assertSafeName(name);
    return path.join(this.exports, name);
  }

  async listExports(): Promise<{ name: string; bytes: number; modifiedAt: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.exports);
    } catch {
      return [];
    }
    const out: { name: string; bytes: number; modifiedAt: number }[] = [];
    for (const name of names) {
      if (name.endsWith(".part")) continue;
      const s = await stat(path.join(this.exports, name));
      if (s.isFile()) out.push({ name, bytes: s.size, modifiedAt: s.mtimeMs });
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async listSessions(): Promise<unknown[]> {
    let ids: string[];
    try {
      ids = await readdir(this.recordings);
    } catch {
      return []; // Nothing recorded yet.
    }
    const out: { createdAt?: number }[] = [];
    for (const id of ids) {
      try {
        assertSafeId(id);
        out.push(JSON.parse(await readFile(path.join(this.recordings, id, "meta.json"), "utf8")));
      } catch {
        // No meta yet (upload in progress) or unreadable: not a listable take.
      }
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertSafeId(sessionId);
    await rm(path.join(this.recordings, sessionId), { recursive: true, force: true });
  }

  async deleteMedia(id: string): Promise<void> {
    await rm(this.mediaFile(id), { force: true });
  }

  async size(file: string): Promise<number | null> {
    try {
      return (await stat(file)).size;
    } catch {
      return null;
    }
  }

  /**
   * Streams a request body to disk without holding it in memory, then renames
   * it into place. When the client declares a length, anything short of it is
   * refused and discarded — the sync step deletes the browser's copy only after
   * the sizes agree, so a truncated file must never be left looking complete.
   */
  async write(target: string, body: ReadableStream<Uint8Array> | null, expected: number | null): Promise<number> {
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.part`;
    const sink = Bun.file(temp).writer({ highWaterMark: 1024 * 1024 });
    try {
      // An explicit read loop rather than `Bun.write(temp, new Response(body))`,
      // which never finished reading a request body in Bun 1.3 — the upload
      // hung with nothing on disk. Counting here also means the length check
      // is against bytes that reached the file, not a figure from a header.
      // getReader() rather than `for await`: the async iterator on a request
      // body intermittently threw "undefined is not a function" in Bun 1.3.
      let written = 0;
      const reader = body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.write(value);
        written += value.byteLength;
        // Flushing as the buffer fills keeps a multi-gigabyte upload from
        // piling up in memory faster than the disk takes it.
        if (written % (8 * 1024 * 1024) < value.byteLength) await sink.flush();
      }
      await sink.end();
      if (expected !== null && written !== expected) throw new TruncatedUpload(expected, written);
      await rename(temp, target);
      return written;
    } catch (err) {
      await Promise.resolve(sink.end()).catch(() => undefined);
      await rm(temp, { force: true });
      throw err;
    }
  }

  /** Bytes used by this workspace, and how much the disk could still hold. */
  async usage(): Promise<{ usage: number; quota: number }> {
    const used = await directorySize(this.workspaceDir);
    let free = 0;
    try {
      const s = await statfs(path.dirname(this.workspaceDir));
      free = s.bavail * s.bsize;
    } catch {
      // Unknown free space is reported as no headroom figure, not an error.
    }
    return { usage: used, quota: used + free };
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

/**
 * Content type by magic bytes. Imported files are stored under their asset id
 * with no extension, so the extension-based guess would call every one of them
 * `application/octet-stream`.
 */
export async function sniffType(file: string): Promise<string> {
  const head = new Uint8Array(await Bun.file(file).slice(0, 16).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  if (ascii(4, 8) === "ftyp") return "video/mp4";
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (head[0] === 0x7b) return "application/json";
  return "application/octet-stream";
}

/**
 * Serves a file with HTTP range support.
 *
 * Ranges are not optional here: `<video>` seeks by asking for byte ranges, and
 * mediabunny's `UrlSource` reads a multi-gigabyte recording a window at a time
 * rather than downloading it. Without 206 responses both fall back to fetching
 * the whole file.
 */
export async function fileResponse(file: string, method: string, rangeHeader: string | undefined): Promise<Response> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) return Response.json({ error: "Not found" }, { status: 404 });

  const size = handle.size;
  const type = await sniffType(file);
  // x-file-size is the whole file's size on every response, ranges and HEAD
  // included. content-length cannot be trusted for that: on a HEAD it may be
  // rewritten to the empty body's length, and on a 206 it is the slice's.
  const base = {
    "accept-ranges": "bytes",
    "content-type": type,
    "cache-control": "no-store",
    "x-file-size": String(size),
  };

  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (match) {
    let start: number;
    let end: number;
    if (match[1] === "" && match[2] !== "") {
      // "bytes=-500" is the last 500 bytes.
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (!Number.isFinite(start) || start >= size || end < start) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    const headers = {
      ...base,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    };
    return new Response(method === "HEAD" ? null : handle.slice(start, end + 1), { status: 206, headers });
  }

  const headers = { ...base, "content-length": String(size) };
  return new Response(method === "HEAD" ? null : handle, { status: 200, headers });
}
