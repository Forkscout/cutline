/**
 * Where projects live when the local server is running.
 *
 * Behind an interface on purpose. Today the only implementation writes JSON
 * files under `~/Cutline`; if this ever becomes a hosted product, the same
 * interface fronts object storage and a database, and nothing above it changes.
 * That is also why every path carries a workspace id even though there is only
 * ever one locally — adding tenancy to paths later means migrating every file a
 * user has, and adding it now costs a string.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Ids are UUIDs. Anything else is refused before it gets near a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class BadId extends Error {
  constructor(id: string) {
    super(`Refusing unsafe id: ${JSON.stringify(id).slice(0, 80)}`);
  }
}

/**
 * The only thing between a request parameter and the filesystem. An id like
 * `../../.ssh/id_rsa` would otherwise be a read or a write anywhere the user
 * can reach.
 */
export function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new BadId(id);
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  durationSec: number;
  trackCount: number;
  assetCount: number;
}

export interface VersionSummary {
  id: string;
  label: string;
  createdAt: number;
  n: number;
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  /** Raw JSON as stored, or null when there is no such project. */
  get(id: string): Promise<string | null>;
  put(id: string, json: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Named snapshots of a project, newest first. */
  listVersions(id: string): Promise<VersionSummary[]>;
  getVersion(id: string, versionId: string): Promise<string | null>;
  putVersion(id: string, label: string, json: string): Promise<VersionSummary>;
}

/** Write beside, then rename: a crash leaves the old file or the new one, never half. */
async function writeAtomic(target: string, text: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, target);
}

export function cutlineHome(): string {
  return process.env.CUTLINE_HOME ?? path.join(homedir(), "Cutline");
}

interface StoredProject {
  id?: string;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  tracks?: { clips?: { start?: number; duration?: number }[] }[];
  assets?: unknown[];
}

/** Projects are written in an envelope; older ones are bare documents. */
function unwrap(parsed: unknown): StoredProject {
  if (parsed && typeof parsed === "object" && "project" in parsed) {
    return (parsed as { project: StoredProject }).project ?? {};
  }
  return (parsed ?? {}) as StoredProject;
}

function summarise(id: string, project: StoredProject): ProjectSummary {
  let duration = 0;
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      duration = Math.max(duration, (clip.start ?? 0) + (clip.duration ?? 0));
    }
  }
  return {
    id,
    name: project.name ?? "Untitled project",
    createdAt: project.createdAt ?? 0,
    updatedAt: project.updatedAt ?? 0,
    durationSec: duration,
    trackCount: project.tracks?.length ?? 0,
    assetCount: project.assets?.length ?? 0,
  };
}

export class DiskProjectStore implements ProjectStore {
  private readonly dir: string;

  constructor(root: string, workspaceId: string) {
    assertSafeId(workspaceId);
    this.dir = path.join(root, "workspaces", workspaceId, "projects");
  }

  private file(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<ProjectSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // No projects directory yet.
    }
    const out: ProjectSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!SAFE_ID.test(id)) continue;
      try {
        out.push(summarise(id, unwrap(JSON.parse(await readFile(path.join(this.dir, name), "utf8")))));
      } catch {
        // One unreadable file must not hide every other project.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<string | null> {
    try {
      return await readFile(this.file(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(id: string, json: string): Promise<void> {
    // Parse before writing: a truncated body would otherwise replace a good
    // project with one that can never be opened again.
    JSON.parse(json);
    const target = this.file(id);
    await mkdir(this.dir, { recursive: true });
    // Write beside, then rename. A rename is atomic on one filesystem, so a
    // crash mid-save leaves either the old project or the new one, never half.
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, json, "utf8");
    await rename(temp, target);
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    await rm(this.versionsDir(id), { recursive: true, force: true });
  }

  /** Versions sit beside their project, in <id>.versions/: a document and its meta, each. */
  private versionsDir(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.versions`);
  }

  async listVersions(id: string): Promise<VersionSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.versionsDir(id));
    } catch {
      return [];
    }
    const out: VersionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".meta.json")) continue;
      try {
        out.push(JSON.parse(await readFile(path.join(this.versionsDir(id), name), "utf8")) as VersionSummary);
      } catch {
        // One unreadable version must not hide the others.
      }
    }
    return out.sort((a, b) => b.n - a.n);
  }

  async getVersion(id: string, versionId: string): Promise<string | null> {
    assertSafeId(versionId);
    try {
      return await readFile(path.join(this.versionsDir(id), `${versionId}.json`), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async putVersion(id: string, label: string, json: string): Promise<VersionSummary> {
    JSON.parse(json);
    const dir = this.versionsDir(id);
    await mkdir(dir, { recursive: true });
    const n = ((await this.listVersions(id))[0]?.n ?? 0) + 1;
    const summary: VersionSummary = { id: `v${n}-${Date.now().toString(36)}`, label: label.trim().slice(0, 80) || `Version ${n}`, createdAt: Date.now(), n };
    // The document first and its meta last: a version is listed only once it can be opened.
    await writeAtomic(path.join(dir, `${summary.id}.json`), json);
    await writeAtomic(path.join(dir, `${summary.id}.meta.json`), JSON.stringify(summary));
    return summary;
  }
}
