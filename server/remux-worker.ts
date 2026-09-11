/**
 * Copy-remux, in a worker.
 *
 * MediaRecorder cannot write a duration or a seek index into a WebM after the
 * take ends, so every recording is remuxed once on import: the same packets,
 * written into a container that has both. Doing it here, file to file, means
 * neither the browser nor this process ever holds the recording in memory —
 * and doing it in a worker means a two-hour take does not stall the thread
 * that answers the page's range requests while it runs.
 */

import { rename, rm, stat } from "node:fs/promises";
import { ALL_FORMATS, Conversion, FilePathSource, FilePathTarget, Input, Output, WebMOutputFormat } from "mediabunny";

declare const self: Worker;

export interface RemuxJob {
  id: string;
  from: string;
  to: string;
}

export type RemuxResult = { id: string; ok: true; bytes: number } | { id: string; ok: false; error: string };

self.onmessage = async (event: MessageEvent<RemuxJob>) => {
  const { id, from, to } = event.data;
  // Beside the target, then renamed: a half-written .edit file must never be
  // mistaken for a finished one by the next import.
  const temp = `${to}.${crypto.randomUUID()}.part`;
  const input = new Input({ source: new FilePathSource(from), formats: ALL_FORMATS });
  try {
    const output = new Output({ format: new WebMOutputFormat(), target: new FilePathTarget(temp) });
    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid) throw new Error("Nothing in the file could be carried over.");
    await conversion.execute();
    await rename(temp, to);
    self.postMessage({ id, ok: true, bytes: (await stat(to)).size } satisfies RemuxResult);
  } catch (err) {
    await rm(temp, { force: true });
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies RemuxResult);
  } finally {
    input.dispose();
  }
};
