/**
 * The page's side of the workspace — brand kits, looks, recipes, references —
 * kept by the server under ~/Cutline/workspaces/local/. Items are plain JSON;
 * their files (a logo, an intro, a reference clip) sit beside them.
 */

import type { BrandKit, Look, Recipe, WorkspaceReference } from "@/editor/types";
import { api, apiJson } from "./server";

export type WorkspaceKind = "brand-kits" | "looks" | "recipes" | "references";
export type ItemOf<K extends WorkspaceKind> = K extends "brand-kits"
  ? BrandKit
  : K extends "looks"
    ? Look
    : K extends "recipes"
      ? Recipe
      : WorkspaceReference;
/** What is sent to save one: the server sets its version and time. */
export type Draft<K extends WorkspaceKind> = Omit<ItemOf<K>, "version" | "updatedAt">;

const base = (kind: WorkspaceKind) => `/api/workspace/${kind}`;
const one = (kind: WorkspaceKind, id: string) => `${base(kind)}/${encodeURIComponent(id)}`;

export const listItems = <K extends WorkspaceKind>(kind: K) => apiJson<ItemOf<K>[]>(base(kind));
export const getItem = <K extends WorkspaceKind>(kind: K, id: string) => apiJson<ItemOf<K>>(one(kind, id));

export const saveItem = <K extends WorkspaceKind>(kind: K, item: Draft<K>) =>
  apiJson<ItemOf<K>>(one(kind, item.id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(item),
  });

export async function removeItem(kind: WorkspaceKind, id: string): Promise<void> {
  await apiJson(one(kind, id), { method: "DELETE" });
}

export const itemFileUrl = (kind: WorkspaceKind, id: string, name: string) => `${one(kind, id)}/files/${encodeURIComponent(name)}`;

/** A name the server will take — letters, digits, dot, dash, underscore — with its extension kept. */
export function fileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(-100);
  return cleaned || `file-${Date.now().toString(36)}`;
}

export async function uploadItemFile(kind: WorkspaceKind, id: string, file: File, as?: string): Promise<string> {
  const name = fileName(as ?? file.name);
  const response = await api(itemFileUrl(kind, id, name), { method: "PUT", body: file });
  if (!response.ok) throw new Error(`Could not store ${file.name} (${response.status}).`);
  return name;
}

export async function fetchItemFile(kind: WorkspaceKind, id: string, name: string): Promise<File> {
  const response = await api(itemFileUrl(kind, id, name));
  if (!response.ok) throw new Error(`${name} is missing from the workspace.`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

/** An id from a name: readable in a folder listing, and unique by its time. */
export const newItemId = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item"}-${Date.now().toString(36)}`;
