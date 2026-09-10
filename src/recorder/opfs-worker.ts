/**
 * Streams recorder chunks straight to disk, inside a worker.
 *
 * The worker is not an optimisation. `createSyncAccessHandle` only exists off
 * the main thread, and it is the only OPFS write path that appends in place.
 * The main-thread alternative, `createWritable`, stages the whole file in a
 * swap copy and commits on close — so an hour of screen capture would need
 * twice the disk and would lose everything if the tab died before the commit.
 * A screen recording is exactly the case where the tab dying is plausible.
 */

/// <reference lib="webworker" />

type OpenMsg = { type: "open"; id: string; sessionId: string; fileName: string };
type WriteMsg = { type: "write"; id: string; buffer: ArrayBuffer };
type CloseMsg = { type: "close"; id: string };
type AbortMsg = { type: "abort"; id: string };
type InMsg = OpenMsg | WriteMsg | CloseMsg | AbortMsg;

type OutMsg =
  | { type: "opened"; id: string }
  | { type: "wrote"; id: string; bytes: number }
  | { type: "closed"; id: string; bytes: number }
  | { type: "aborted"; id: string }
  | { type: "error"; id: string; message: string };

interface OpenFile {
  handle: FileSystemSyncAccessHandle;
  sessionId: string;
  fileName: string;
  offset: number;
}

const openFiles = new Map<string, OpenFile>();

function post(msg: OutMsg) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

async function sessionDir(sessionId: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle("recordings", { create: true });
  return recordings.getDirectoryHandle(sessionId, { create: true });
}

async function handleOpen(msg: OpenMsg) {
  const dir = await sessionDir(msg.sessionId);
  const fileHandle = await dir.getFileHandle(msg.fileName, { create: true });
  const handle = await fileHandle.createSyncAccessHandle();
  // A re-open of an existing name must not append to stale bytes.
  handle.truncate(0);
  openFiles.set(msg.id, { handle, sessionId: msg.sessionId, fileName: msg.fileName, offset: 0 });
  post({ type: "opened", id: msg.id });
}

function handleWrite(msg: WriteMsg) {
  const file = openFiles.get(msg.id);
  if (!file) throw new Error(`write to unopened file ${msg.id}`);
  const written = file.handle.write(new Uint8Array(msg.buffer), { at: file.offset });
  file.offset += written;
  post({ type: "wrote", id: msg.id, bytes: file.offset });
}

function handleClose(msg: CloseMsg) {
  const file = openFiles.get(msg.id);
  if (!file) throw new Error(`close of unopened file ${msg.id}`);
  file.handle.flush();
  file.handle.close();
  openFiles.delete(msg.id);
  post({ type: "closed", id: msg.id, bytes: file.offset });
}

async function handleAbort(msg: AbortMsg) {
  const file = openFiles.get(msg.id);
  if (!file) {
    post({ type: "aborted", id: msg.id });
    return;
  }
  file.handle.close();
  openFiles.delete(msg.id);
  try {
    const dir = await sessionDir(file.sessionId);
    await dir.removeEntry(file.fileName);
  } catch {
    // The partial file not existing is the outcome we wanted anyway.
  }
  post({ type: "aborted", id: msg.id });
}

self.onmessage = async (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "open":
        await handleOpen(msg);
        break;
      case "write":
        handleWrite(msg);
        break;
      case "close":
        handleClose(msg);
        break;
      case "abort":
        await handleAbort(msg);
        break;
    }
  } catch (err) {
    post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
