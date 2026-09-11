/**
 * The browser side of storage, which is now only a capture buffer.
 *
 *   OpfsWriter      — the hot path: chunks going to disk while recording.
 *   local sessions  — what the recorder left in OPFS, read by the sync step
 *                     that moves each finished take to the local server.
 *   legacy projects — read once, to migrate projects saved before the server.
 *
 * Recording still writes to OPFS first, deliberately. It is local, it survives
 * the tab dying mid-take, and it does not care whether the server is running —
 * a take must never be lost because a process on the other side of an HTTP
 * connection restarted. Everything that reads finished media reads it from the
 * server (`@/lib/media-store`).
 */

import type { SessionMeta } from "./types";

const RECORDINGS_DIR = "recordings";
const MEDIA_DIR = "media";
const PROJECTS_DIR = "projects";
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

/* ----------------------------------------------------------- local sessions */

async function namedDir(name: string, create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create });
}

async function entries(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
  const out: [string, FileSystemHandle][] = [];
  for await (const entry of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    out.push(entry);
  }
  return out;
}

/** Written by the recorder at stop. Its presence is what marks a take complete. */
export async function writeSessionMeta(meta: SessionMeta): Promise<void> {
  const dir = await namedDir(RECORDINGS_DIR, true);
  const sessionDir = await dir.getDirectoryHandle(meta.id, { create: true });
  const handle = await sessionDir.getFileHandle(META_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(meta, null, 2));
  await writable.close();
}

export async function readLocalSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  try {
    const dir = await namedDir(RECORDINGS_DIR);
    const sessionDir = await dir.getDirectoryHandle(sessionId);
    const handle = await sessionDir.getFileHandle(META_FILE);
    return JSON.parse(await (await handle.getFile()).text()) as SessionMeta;
  } catch {
    return null;
  }
}

/** Every session directory still in OPFS, complete or not. */
export async function listLocalSessionIds(): Promise<string[]> {
  try {
    const dir = await namedDir(RECORDINGS_DIR);
    return (await entries(dir)).filter(([, h]) => h.kind === "directory").map(([name]) => name);
  } catch {
    return []; // Nothing recorded yet.
  }
}

/** Finished takes still in OPFS, newest first. */
export async function listLocalSessions(): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  for (const id of await listLocalSessionIds()) {
    const meta = await readLocalSessionMeta(id);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The files of one local session. `.crswap` files are Chrome's staging copies
 * from `createWritable` and are never part of a take.
 */
export async function localSessionFiles(sessionId: string): Promise<{ name: string; file: File }[]> {
  const dir = await namedDir(RECORDINGS_DIR);
  const sessionDir = await dir.getDirectoryHandle(sessionId);
  const out: { name: string; file: File }[] = [];
  for (const [name, handle] of await entries(sessionDir)) {
    if (handle.kind !== "file" || name.endsWith(".crswap")) continue;
    out.push({ name, file: await (handle as FileSystemFileHandle).getFile() });
  }
  return out;
}

export async function getLocalTrackFile(sessionId: string, fileName: string): Promise<File> {
  const dir = await namedDir(RECORDINGS_DIR);
  const sessionDir = await dir.getDirectoryHandle(sessionId);
  return (await sessionDir.getFileHandle(fileName)).getFile();
}

export async function deleteLocalSession(sessionId: string): Promise<void> {
  const dir = await namedDir(RECORDINGS_DIR);
  await dir.removeEntry(sessionId, { recursive: true });
}

/* ------------------------------------------------------------- local media */

/** Files imported before media moved to the server, still waiting to go up. */
export async function listLocalMediaIds(): Promise<string[]> {
  try {
    const dir = await namedDir(MEDIA_DIR);
    return (await entries(dir))
      .filter(([name, h]) => h.kind === "file" && !name.endsWith(".crswap"))
      .map(([name]) => name);
  } catch {
    return [];
  }
}

export async function getLocalMediaFile(fileId: string): Promise<File> {
  const dir = await namedDir(MEDIA_DIR);
  return (await dir.getFileHandle(fileId)).getFile();
}

export async function deleteLocalMediaFile(fileId: string): Promise<void> {
  try {
    const dir = await namedDir(MEDIA_DIR);
    await dir.removeEntry(fileId);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

/* --------------------------------------------------------- legacy projects */

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
  try {
    const dir = await namedDir(PROJECTS_DIR);
    return (await entries(dir))
      .filter(([name, h]) => h.kind === "file" && name.endsWith(".json"))
      .map(([name]) => name.replace(/\.json$/, ""));
  } catch {
    return []; // No projects directory yet.
  }
}

/* ------------------------------------------------------------------ misc */

/**
 * Without this, the browser may evict the capture buffer under disk pressure —
 * which for a screen capture the user just spent an hour on is not an
 * acceptable outcome, even if it is about to be uploaded. Chrome grants it
 * silently to engaged origins; a refusal is not fatal, so the caller only
 * reports it.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
