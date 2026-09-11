/**
 * What is reused across videos — brand kits, looks, recipes, references —
 * under ~/Cutline/workspaces/<workspace>/<kind>/: one JSON document per item,
 * and a folder of its files beside it.
 *
 * A project copies what it uses, so an item edited later never changes a
 * finished video behind anyone's back. Every save bumps `version`; that is how
 * a project tells its copy is behind, and offers the update instead of taking
 * it. Like the project store, it knows nothing of what the documents mean.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeId } from "./store";

export const WORKSPACE_KINDS = ["brand-kits", "looks", "recipes", "references"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const isWorkspaceKind = (kind: string): kind is WorkspaceKind => (WORKSPACE_KINDS as readonly string[]).includes(kind);

/** A file name inside an item's folder: no separators, no leading dot, nothing that climbs out. */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class BadFileName extends Error {}

type Doc = Record<string, unknown> & { id: string; version: number; updatedAt: number };

async function writeAtomic(target: string, text: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, target);
}

export class WorkspaceStore {
  private readonly root: string;

  constructor(root: string, workspaceId: string) {
    assertSafeId(workspaceId);
    this.root = path.join(root, "workspaces", workspaceId);
  }

  private dir(kind: WorkspaceKind): string {
    return path.join(this.root, kind);
  }

  private doc(kind: WorkspaceKind, id: string): string {
    assertSafeId(id);
    return path.join(this.dir(kind), `${id}.json`);
  }

  private folder(kind: WorkspaceKind, id: string): string {
    assertSafeId(id);
    return path.join(this.dir(kind), id);
  }

  async list(kind: WorkspaceKind): Promise<Doc[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(kind));
    } catch {
      return [];
    }
    const out: Doc[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(path.join(this.dir(kind), name), "utf8")) as Doc);
      } catch {
        // One unreadable item must not hide the rest.
      }
    }
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async get(kind: WorkspaceKind, id: string): Promise<Doc | null> {
    try {
      return JSON.parse(await readFile(this.doc(kind, id), "utf8")) as Doc;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Saves an item, one version past the last; the id comes from the URL, never the body. */
  async put(kind: WorkspaceKind, id: string, body: Record<string, unknown>): Promise<Doc> {
    const previous = await this.get(kind, id);
    const next: Doc = { ...body, id, version: (previous?.version ?? 0) + 1, updatedAt: Date.now() };
    await mkdir(this.dir(kind), { recursive: true });
    await writeAtomic(this.doc(kind, id), JSON.stringify(next, null, 2));
    return next;
  }

  async remove(kind: WorkspaceKind, id: string): Promise<void> {
    await rm(this.doc(kind, id), { force: true });
    await rm(this.folder(kind, id), { recursive: true, force: true });
  }

  /** Where one of an item's files lives, its folder made on the way. */
  async file(kind: WorkspaceKind, id: string, name: string, create = false): Promise<string> {
    if (!SAFE_FILE.test(name) || name.includes("..")) throw new BadFileName(`Not a file name: ${name}`);
    const folder = this.folder(kind, id);
    if (create) await mkdir(folder, { recursive: true });
    return path.join(folder, name);
  }
}
