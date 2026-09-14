/**
 * Saving and loading projects.
 *
 * Projects live on the local server now, as files under `~/Cutline`, rather
 * than in the browser's private file system. That matters more than it looks:
 * OPFS is invisible to the user and one "clear browsing data" away from gone,
 * and it cannot be reached by anything outside the tab — not a backup, not an
 * agent. The server is also where a hosted version would put the same calls.
 *
 * What stays in the browser is the crash-recovery copy, because it has to be
 * written synchronously at the moment things go wrong.
 */

import { listProjectFiles, readProjectFile } from "@/recorder/storage";
import { api, apiJson } from "@/lib/server";
import { assetExists } from "./media";
import { EMPTY_BRIEF, type Project } from "./types";

const RECOVERY_KEY = "cutline.recovery";
const MIGRATED_KEY = "cutline.migrated-to-server.v1";
const SCHEMA_VERSION = 1;

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  durationSec: number;
  trackCount: number;
  assetCount: number;
}

interface Envelope {
  version: number;
  project: Project;
}

/* --------------------------------------------------------------- migration */

let migration: Promise<void> | null = null;

/**
 * Moves projects saved before the server existed from OPFS onto disk, once.
 *
 * Without this, the first run after upgrading would show an empty project
 * list and the user would reasonably conclude their work had been deleted. The
 * OPFS copies are left in place — deleting them is not this function's job, and
 * a copy that is never read costs nothing.
 */
function migrateLocalProjects(): Promise<void> {
  if (migration) return migration;
  migration = (async () => {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
    } catch {
      // No localStorage: try the migration anyway; it is idempotent.
    }
    const existing = new Set((await apiJson<ProjectSummary[]>("/api/projects")).map((p) => p.id));
    for (const id of await listProjectFiles()) {
      if (existing.has(id)) continue;
      const raw = await readProjectFile(id);
      if (!raw) continue;
      await api(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: raw,
      });
    }
    try {
      localStorage.setItem(MIGRATED_KEY, String(Date.now()));
    } catch {
      // It will simply run again next time, and find nothing to do.
    }
  })();
  // A failed attempt must not be cached, or it would never be retried.
  migration.catch(() => {
    migration = null;
  });
  return migration;
}

/* ------------------------------------------------------------ save / load */

export async function listProjects(): Promise<ProjectSummary[]> {
  await migrateLocalProjects();
  return apiJson<ProjectSummary[]>("/api/projects");
}

export async function saveProject(project: Project): Promise<void> {
  const envelope: Envelope = { version: SCHEMA_VERSION, project };
  await apiJson(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  clearRecovery();
}

export interface VersionSummary {
  id: string;
  label: string;
  createdAt: number;
  /** 1, 2, 3… in the order they were saved. */
  n: number;
}

/** Saves the project as it is now, under a name, beside it on the server. */
export async function saveVersion(project: Project, label: string): Promise<VersionSummary> {
  const envelope: Envelope = { version: SCHEMA_VERSION, project };
  return apiJson<VersionSummary>(`/api/projects/${encodeURIComponent(project.id)}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, ...envelope }),
  });
}

export const listVersions = (projectId: string) =>
  apiJson<VersionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/versions`);

/** A saved version, brought up to date the way an opened project is. */
export async function loadVersion(projectId: string, versionId: string): Promise<Project> {
  const raw = await apiJson<Partial<Envelope> & Partial<Project>>(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
  );
  return migrate((raw.project ?? raw) as Project);
}

export async function loadProject(projectId: string): Promise<Project | null> {
  const response = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not open the project (${response.status}).`);
  try {
    const parsed = (await response.json()) as Envelope | Project;
    // Projects written before the envelope existed are bare documents.
    const project = "version" in parsed ? parsed.project : parsed;
    return migrate(project);
  } catch {
    return null;
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiJson(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

export async function duplicateProject(project: Project): Promise<Project> {
  const copy: Project = structuredClone(project);
  copy.id = crypto.randomUUID();
  copy.name = `${project.name} copy`;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  await saveProject(copy);
  return copy;
}

/**
 * Fills in anything a newer schema added. Old projects should open, not error —
 * a missing field is a default, never a failure.
 */
export function migrate(project: Project): Project {
  return {
    ...project,
    markers: project.markers ?? [],
    bins: project.bins ?? [],
    captions: project.captions ?? [],
    // Projects from before briefs and themes: an empty brief, no theme chosen.
    brief: { ...EMPTY_BRIEF, ...project.brief, brand: { ...EMPTY_BRIEF.brand, ...project.brief?.brand } },
    theme: project.theme ?? null,
    storyboard: project.storyboard ?? null,
    facts: project.facts ?? [],
    services: project.services ?? {},
    voices: project.voices ?? [],
    imageStyles: project.imageStyles ?? [],
    assets: (project.assets ?? []).map((asset) => ({ ...asset, tags: asset.tags ?? [] })),
    tracks: (project.tracks ?? []).map((track) => ({
      ...track,
      solo: track.solo ?? false,
      locked: track.locked ?? false,
      // Kept for older readers; the timeline sizes rows by what they hold.
      height: track.height ?? 48,
      color: track.color ?? null,
      clips: track.clips.map((clip) => ({
        ...clip,
        keyframes: clip.keyframes ?? [],
        effects: clip.effects ?? [],
        linkId: clip.linkId ?? null,
        enabled: clip.enabled ?? true,
      })),
    })),
  };
}

/* ---------------------------------------------------------------- recovery */

/**
 * A crash-recovery copy, written to localStorage on a short interval.
 *
 * Deliberately not the server: a network write is async and can be cut off
 * halfway, which is exactly the moment a crash copy is needed. localStorage
 * writes synchronously and atomically, and a project's JSON is small enough.
 */
export function writeRecovery(project: Project): void {
  try {
    localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify({ savedAt: Date.now(), project } satisfies { savedAt: number; project: Project }),
    );
  } catch {
    // Over quota — the real save is still the source of truth.
  }
}

export function readRecovery(): { savedAt: number; project: Project } | null {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; project: Project };
    return { savedAt: parsed.savedAt, project: migrate(parsed.project) };
  } catch {
    return null;
  }
}

export function clearRecovery(): void {
  try {
    localStorage.removeItem(RECOVERY_KEY);
  } catch {
    // Nothing to do.
  }
}

/* ------------------------------------------------------- offline detection */

/**
 * Marks assets whose bytes can no longer be read. A project that silently
 * renders black where a clip used to be is far worse than one that says which
 * file went missing.
 */
export async function detectOfflineMedia(project: Project): Promise<Project> {
  // A HEAD per asset, not a download: this used to read every file in the
  // project just to learn that it was there.
  const assets = await Promise.all(
    project.assets.map(async (asset) => {
      const present = await assetExists(asset).catch(() => false);
      if (present) return asset.offline ? { ...asset, offline: false } : asset;
      return { ...asset, offline: true };
    }),
  );
  const changed = assets.some((a, i) => a !== project.assets[i]);
  return changed ? { ...project, assets } : project;
}
