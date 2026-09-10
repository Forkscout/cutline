/**
 * Saving and loading projects.
 *
 * A project is plain JSON by construction, so persistence is `stringify` plus a
 * file write. What needs care is everything around that: autosave that does not
 * fight the user's typing, a recovery copy that survives a crash mid-write, and
 * detecting media that has gone missing between sessions.
 */

import {
  deleteProjectFile,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
} from "@/recorder/storage";
import { assetFile } from "./media";
import type { Project } from "./types";

const INDEX_KEY = "cutline.projects";
const RECOVERY_KEY = "cutline.recovery";
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

/* ------------------------------------------------------------------- index */

/**
 * The list of projects lives in localStorage, the projects themselves in OPFS.
 *
 * Reading a directory of JSON files just to render a list means parsing every
 * project to show its name; a small synchronous index avoids that, and is
 * rebuilt from OPFS if it is ever lost.
 */
function readIndex(): ProjectSummary[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as ProjectSummary[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(summaries: ProjectSummary[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(summaries));
  } catch {
    // A full or disabled localStorage must not stop a save; the index is a
    // cache and rebuildIndex can recover it.
  }
}

export function summarise(project: Project): ProjectSummary {
  let duration = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) duration = Math.max(duration, clip.start + clip.duration);
  }
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    durationSec: duration,
    trackCount: project.tracks.length,
    assetCount: project.assets.length,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const index = readIndex();
  if (index.length > 0) return [...index].sort((a, b) => b.updatedAt - a.updatedAt);
  return rebuildIndex();
}

/** Reads every project off disk to rebuild a lost or empty index. */
export async function rebuildIndex(): Promise<ProjectSummary[]> {
  const ids = await listProjectFiles();
  const summaries: ProjectSummary[] = [];
  for (const id of ids) {
    const project = await loadProject(id);
    if (project) summaries.push(summarise(project));
  }
  writeIndex(summaries);
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ------------------------------------------------------------ save / load */

export async function saveProject(project: Project): Promise<void> {
  const envelope: Envelope = { version: SCHEMA_VERSION, project };
  await writeProjectFile(project.id, JSON.stringify(envelope));

  const summary = summarise(project);
  const index = readIndex().filter((s) => s.id !== project.id);
  writeIndex([summary, ...index]);
  clearRecovery();
}

export async function loadProject(projectId: string): Promise<Project | null> {
  const raw = await readProjectFile(projectId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Envelope | Project;
    // Projects written before the envelope existed are bare documents.
    const project = "version" in parsed ? parsed.project : parsed;
    return migrate(project);
  } catch {
    return null;
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  await deleteProjectFile(projectId);
  writeIndex(readIndex().filter((s) => s.id !== projectId));
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
function migrate(project: Project): Project {
  return {
    ...project,
    markers: project.markers ?? [],
    bins: project.bins ?? [],
    captions: project.captions ?? [],
    assets: project.assets ?? [],
    tracks: (project.tracks ?? []).map((track) => ({
      ...track,
      solo: track.solo ?? false,
      locked: track.locked ?? false,
      height: track.height ?? 64,
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
 * Deliberately not OPFS: an OPFS write is async and can be interrupted halfway,
 * which is exactly the moment a crash copy is needed. localStorage writes
 * atomically, and a project's JSON is small enough to fit.
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
  const assets = await Promise.all(
    project.assets.map(async (asset) => {
      try {
        await assetFile(asset);
        return asset.offline ? { ...asset, offline: false } : asset;
      } catch {
        return { ...asset, offline: true };
      }
    }),
  );
  const changed = assets.some((a, i) => a !== project.assets[i]);
  return changed ? { ...project, assets } : project;
}
