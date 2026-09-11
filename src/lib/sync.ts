/**
 * Moves finished takes from the browser's capture buffer to the local server.
 *
 * The recorder writes to OPFS because a take must survive the tab dying and
 * must not depend on a server being up. This is the second half: once a take is
 * finished, copy it to disk where the rest of the app — and any agent — can
 * reach it, then delete the browser's copy so it is not stored twice.
 *
 * It is also the migration: sessions and imported files left in OPFS by earlier
 * versions go up the same way, the first time this runs.
 *
 * Three rules, because the last step is a deletion:
 *
 *  - A session with no `meta.json` is never touched. That is a take still
 *    recording, or one that crashed mid-capture — and a crashed take's chunks
 *    are the only copy there is.
 *  - `meta.json` is uploaded last, so the server never lists a take whose media
 *    is still arriving.
 *  - The local copy is deleted only after every file's size on the server has
 *    been read back and matches.
 */

import {
  deleteLocalMediaFile,
  deleteLocalSession,
  getLocalMediaFile,
  listLocalMediaIds,
  listLocalSessionIds,
  localSessionFiles,
} from "@/recorder/storage";
import { mediaFileSize, sessionFileSize, writeMediaFile, writeSessionFile } from "./media-store";

export interface SyncReport {
  sessions: number;
  files: number;
  bytes: number;
  /** Local sessions left alone because they have no meta.json. */
  skipped: number;
}

export interface SyncProgress {
  name: string;
  done: number;
  total: number;
}

let running: Promise<SyncReport> | null = null;

/**
 * Single-flight: every caller during a sync waits on the same one. Across tabs
 * too — a Web Lock makes a second tab wait for the first to finish, then find
 * nothing left to move, instead of both uploading the same take and one
 * reading files the other has just deleted.
 */
export function syncLocalRecordings(onProgress?: (p: SyncProgress) => void): Promise<SyncReport> {
  if (running) return running;
  const exclusive: Promise<SyncReport> = navigator.locks
    ? navigator.locks.request("cutline-sync", () => run(onProgress)).then((report) => report)
    : run(onProgress);
  const current = exclusive.finally(() => {
    running = null;
  });
  running = current;
  return current;
}

async function run(onProgress?: (p: SyncProgress) => void): Promise<SyncReport> {
  const report: SyncReport = { sessions: 0, files: 0, bytes: 0, skipped: 0 };

  const sessionIds = await listLocalSessionIds();
  const mediaIds = await listLocalMediaIds();
  const total = sessionIds.length + mediaIds.length;
  let done = 0;

  for (const sessionId of sessionIds) {
    const files = await localSessionFiles(sessionId);
    if (!files.some((f) => f.name === "meta.json")) {
      report.skipped += 1;
      done += 1;
      continue;
    }
    onProgress?.({ name: sessionId, done, total });

    const ordered = [
      ...files.filter((f) => f.name !== "meta.json"),
      ...files.filter((f) => f.name === "meta.json"),
    ];

    for (const { name, file } of ordered) {
      // Already there at the right size means an earlier sync got this far and
      // was interrupted; do not send it again.
      if ((await sessionFileSize(sessionId, name)) === file.size) continue;
      await writeSessionFile(sessionId, name, file);
      report.files += 1;
      report.bytes += file.size;
    }

    for (const { name, file } of ordered) {
      const remote = await sessionFileSize(sessionId, name);
      if (remote !== file.size) {
        throw new Error(
          `${sessionId}/${name} is ${remote ?? "missing"} bytes on the server, ${file.size} locally — keeping the local copy.`,
        );
      }
    }

    await deleteLocalSession(sessionId);
    report.sessions += 1;
    done += 1;
  }

  for (const fileId of mediaIds) {
    onProgress?.({ name: fileId, done, total });
    const file = await getLocalMediaFile(fileId);
    if ((await mediaFileSize(fileId)) !== file.size) {
      await writeMediaFile(fileId, file);
      report.files += 1;
      report.bytes += file.size;
    }
    if ((await mediaFileSize(fileId)) !== file.size) {
      throw new Error(`${fileId} did not arrive intact — keeping the local copy.`);
    }
    await deleteLocalMediaFile(fileId);
    done += 1;
  }

  return report;
}
