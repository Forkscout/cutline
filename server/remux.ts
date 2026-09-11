/**
 * Runs remux jobs on a worker. One worker, started on first use; a second
 * request for a target already being written waits on the first rather than
 * writing it twice.
 */

import type { RemuxJob, RemuxResult } from "./remux-worker";

/**
 * How long an idle worker is kept. A remux leaves tens of megabytes behind in
 * the worker's heap (measured: +47 MB after a 361 MB file, never returned);
 * ending the worker when nothing is queued gives it back, and starting a new
 * one for the next import costs milliseconds.
 */
const IDLE_MS = 30_000;

interface Pending {
  resolve: (bytes: number) => void;
  reject: (err: Error) => void;
}

export class Remuxer {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();
  private running = new Map<string, Promise<number>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private spawn(): Worker {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./remux-worker.ts", import.meta.url).href);
    worker.onmessage = (event: MessageEvent<RemuxResult>) => {
      const result = event.data;
      const job = this.pending.get(result.id);
      if (!job) return;
      this.pending.delete(result.id);
      if (result.ok) job.resolve(result.bytes);
      else job.reject(new Error(result.error));
      if (this.pending.size === 0) this.scheduleIdle();
    };
    worker.onerror = (event) => {
      // Every job in flight is lost with the worker; fail them all loudly and
      // start a fresh worker for the next request.
      for (const job of this.pending.values()) job.reject(new Error(event.message || "The remux worker crashed."));
      this.pending.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0 || !this.worker) return;
      this.worker.terminate();
      this.worker = null;
      this.idleTimer = null;
    }, IDLE_MS);
  }

  /** Remuxes `from` into `to`, resolving the size written. */
  remux(from: string, to: string): Promise<number> {
    const existing = this.running.get(to);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const job = new Promise<number>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.spawn().postMessage({ id, from, to } satisfies RemuxJob);
    }).finally(() => this.running.delete(to));
    this.running.set(to, job);
    return job;
  }
}
