/**
 * Everything on disk. Two halves:
 *
 *   OpfsWriter  — the hot path, chunks going to the worker while recording.
 *   session CRUD — small, cold, main-thread reads of finished recordings.
 */

import type { SessionMeta } from "./types";

const RECORDINGS_DIR = "recordings";
const META_FILE = "meta.json";

/* ------------------------------------------------------------------ writing */

type Pending = { resolve: (bytes: number) => void; reject: (err: Error) => void };

export class OpfsWriter {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private bytes = new Map<string, number>();

  /** Called whenever a file's on-disk size changes, so the UI can show growth. */
  onProgress: ((id: string, bytes: number) => void) | null = null;
  /** Called for failures that arrive with no request waiting on them. */
  onError: ((id: string, message: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => this.receive(event.data);
  }

  private receive(msg: {
    type: "opened" | "wrote" | "closed" | "aborted" | "error";
    id: string;
    bytes?: number;
    message?: string;
  }) {
    if (msg.type === "wrote") {
      const bytes = msg.bytes ?? 0;
      this.bytes.set(msg.id, bytes);
      this.onProgress?.(msg.id, bytes);
      return;
    }
    const waiting = this.pending.get(msg.id);
    if (msg.type === "error") {
      this.pending.delete(msg.id);
      if (waiting) waiting.reject(new Error(msg.message ?? "storage error"));
      else this.onError?.(msg.id, msg.message ?? "storage error");
      return;
    }
    this.pending.delete(msg.id);
    waiting?.resolve(msg.bytes ?? this.bytes.get(msg.id) ?? 0);
  }

  private request(id: string, send: () => void): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send();
    });
  }

  open(id: string, sessionId: string, fileName: string): Promise<number> {
    this.bytes.set(id, 0);
    return this.request(id, () =>
      this.worker.postMessage({ type: "open", id, sessionId, fileName }),
    );
  }

  /**
   * Fire-and-forget by design. Awaiting each chunk would let the recorder's
   * queue outrun the disk unnoticed; instead the buffer is transferred (not
   * copied) and failures arrive on `onError`.
   */
  write(id: string, buffer: ArrayBuffer): void {
    this.worker.postMessage({ type: "write", id, buffer }, [buffer]);
  }

  close(id: string): Promise<number> {
    return this.request(id, () => this.worker.postMessage({ type: "close", id }));
  }

  abort(id: string): Promise<number> {
    return this.request(id, () => this.worker.postMessage({ type: "abort", id }));
  }

  bytesWritten(id: string): number {
    return this.bytes.get(id) ?? 0;
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

/* ------------------------------------------------------------------ reading */

async function recordingsDir(create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECORDINGS_DIR, { create });
}

export async function writeSessionMeta(meta: SessionMeta): Promise<void> {
  const dir = await recordingsDir(true);
  const sessionDir = await dir.getDirectoryHandle(meta.id, { create: true });
  const handle = await sessionDir.getFileHandle(META_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(meta, null, 2));
  await writable.close();
}

export async function readSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  try {
    const dir = await recordingsDir();
    const sessionDir = await dir.getDirectoryHandle(sessionId);
    const handle = await sessionDir.getFileHandle(META_FILE);
    const text = await (await handle.getFile()).text();
    return JSON.parse(text) as SessionMeta;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await recordingsDir();
  } catch {
    return out; // Nothing recorded yet.
  }
  for await (const [name, handle] of dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind !== "directory") continue;
    const meta = await readSessionMeta(name);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const dir = await recordingsDir();
  await dir.removeEntry(sessionId, { recursive: true });
}

/** Writes an arbitrary file into a session's directory (used by the remuxer). */
export async function writeSessionFile(
  sessionId: string,
  fileName: string,
  data: BufferSource,
): Promise<void> {
  const dir = await recordingsDir(true);
  const sessionDir = await dir.getDirectoryHandle(sessionId, { create: true });
  const handle = await sessionDir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function sessionFileExists(sessionId: string, fileName: string): Promise<boolean> {
  try {
    const dir = await recordingsDir();
    const sessionDir = await dir.getDirectoryHandle(sessionId);
    await sessionDir.getFileHandle(fileName);
    return true;
  } catch {
    return false;
  }
}

export async function getTrackFile(sessionId: string, fileName: string): Promise<File> {
  const dir = await recordingsDir();
  const sessionDir = await dir.getDirectoryHandle(sessionId);
  const handle = await sessionDir.getFileHandle(fileName);
  return handle.getFile();
}

/* ------------------------------------------------- imported media & projects */

/**
 * Files the user dropped in are copied into OPFS rather than held as `File`
 * handles. A `File` from a drop is only valid for the life of the page, so a
 * project referencing one would come back broken after a reload — which is
 * exactly when the user expects it to work.
 */
const MEDIA_DIR = "media";
const PROJECTS_DIR = "projects";

async function namedDir(name: string, create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create });
}

export async function writeMediaFile(fileId: string, data: Blob): Promise<void> {
  const dir = await namedDir(MEDIA_DIR, true);
  const handle = await dir.getFileHandle(fileId, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function getMediaFile(fileId: string): Promise<File> {
  const dir = await namedDir(MEDIA_DIR);
  return (await dir.getFileHandle(fileId)).getFile();
}

export async function deleteMediaFile(fileId: string): Promise<void> {
  try {
    const dir = await namedDir(MEDIA_DIR);
    await dir.removeEntry(fileId);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

export async function writeProjectFile(projectId: string, json: string): Promise<void> {
  const dir = await namedDir(PROJECTS_DIR, true);
  const handle = await dir.getFileHandle(`${projectId}.json`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
}

export async function readProjectFile(projectId: string): Promise<string | null> {
  try {
    const dir = await namedDir(PROJECTS_DIR);
    const handle = await dir.getFileHandle(`${projectId}.json`);
    return (await handle.getFile()).text();
  } catch {
    return null;
  }
}

export async function listProjectFiles(): Promise<string[]> {
  const out: string[] = [];
  try {
    const dir = await namedDir(PROJECTS_DIR);
    for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind === "file" && name.endsWith(".json")) out.push(name.replace(/\.json$/, ""));
    }
  } catch {
    // No projects directory yet.
  }
  return out;
}

export async function deleteProjectFile(projectId: string): Promise<void> {
  try {
    const dir = await namedDir(PROJECTS_DIR);
    await dir.removeEntry(`${projectId}.json`);
  } catch {
    // Already gone.
  }
}

export interface StorageUsage {
  usage: number;
  quota: number;
}

export async function estimateUsage(): Promise<StorageUsage> {
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}

/**
 * Without this, the browser may evict recordings under disk pressure — which
 * for a screen capture the user just spent an hour on is not an acceptable
 * outcome. Chrome grants it silently to engaged origins; a refusal is not
 * fatal, so the caller only reports it.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
