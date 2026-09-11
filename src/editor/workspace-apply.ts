/**
 * Bringing workspace items into a project — always as copies. A recipe fills
 * the brief's gaps; a brand kit sets the theme's colours and faces, copies its
 * files into the project's media (a Brand bin) and writes its rules into the
 * brief; a look becomes the project's theme; a reference is attached to the
 * brief with its file copied in beside the footage. The brief records where
 * each came from and which version, so a kit edited later is offered as an
 * update and never changes a finished video behind anyone's back.
 *
 * The editor's buttons and the agent's tools both come through here: they
 * hand over the live project and a commit, as the macros do.
 */

import { fetchItemFile } from "@/lib/workspace";
import { importFiles } from "./media";
import type { Action } from "./project";
import { brandOverrides, mergeTheme, themeOf } from "./themes";
import type { BrandKit, Brief, BriefReference, Look, MediaAsset, Project, Recipe, Theme, WorkspaceReference } from "./types";

export interface ApplyContext {
  project(): Project;
  commit(action: Action): void;
}

type BriefPatch = Extract<Action, { type: "setBrief" }>["patch"];

const unique = (list: string[]) => [...new Set(list.filter(Boolean))];

/** A recipe's defaults, only where the brief is still empty — never over what the client said. */
export function recipeBrief(brief: Brief, recipe: Recipe): BriefPatch {
  const d = recipe.brief;
  return {
    ...(d.platform && !brief.platform ? { platform: d.platform } : {}),
    ...(d.layout && !brief.layout ? { layout: d.layout } : {}),
    ...(d.captions && !brief.captions ? { captions: d.captions } : {}),
    ...(d.tone && !brief.tone ? { tone: d.tone } : {}),
    ...(d.audience && !brief.audience ? { audience: d.audience } : {}),
    rules: unique([...brief.rules, ...(d.rules ?? [])]),
    sources: { ...brief.sources, recipe: { id: recipe.id, name: recipe.name, version: recipe.version } },
  };
}

/** The theme with the kit's colours — the accent kept readable on the ground — and its faces first. */
export function kitTheme(base: Theme, kit: BrandKit): { theme: Theme; notes: string[] } {
  const colors = kit.colors.map((c) => c.trim()).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c));
  const proposal = colors.length ? brandOverrides(colors.map((hex, i) => ({ hex, share: (colors.length - i) / colors.length })), base) : null;
  const family = (f: string) => (/\s/.test(f) ? `"${f}"` : f);
  const fonts = kit.fonts.map((f) => f.trim()).filter(Boolean);
  const theme = mergeTheme(base, {
    ...(proposal?.overrides ?? {}),
    ...(fonts.length ? { fonts: { display: `${family(fonts[0]!)}, ${base.fonts.display}`, body: `${family(fonts[1] ?? fonts[0]!)}, ${base.fonts.body}` } } : {}),
  });
  return { theme: { ...theme, name: `${base.name.replace(/ · .*$/, "")} · ${kit.name}` }, notes: proposal?.notes ?? [] };
}

/** What a kit writes into the brief: its brand, its tone and layout where the brief has none, its rules. */
export function kitBrief(brief: Brief, kit: BrandKit, logoAssetId: string | null): BriefPatch {
  return {
    brand: { name: kit.name, colors: kit.colors, fonts: kit.fonts, notes: kit.notes, ...(logoAssetId ? { logoAssetId } : {}) },
    ...(kit.tone && !brief.tone ? { tone: kit.tone } : {}),
    ...(kit.layout && !brief.layout ? { layout: kit.layout } : {}),
    rules: unique([...brief.rules, ...kit.rules]),
    sources: { ...brief.sources, brandKit: { id: kit.id, name: kit.name, version: kit.version } },
  };
}

/** A top-level bin by name, made if it is not there yet. */
function binFor(ctx: ApplyContext, name: string): string {
  const found = ctx.project().bins.find((b) => b.name === name && !b.parentId);
  if (found) return found.id;
  ctx.commit({ type: "addBin", name });
  const made = ctx.project().bins.find((b) => b.name === name && !b.parentId);
  if (!made) throw new Error(`Could not make the ${name} bin.`);
  return made.id;
}

/** Copies files kept in the workspace into the project's media: the project stays whole without them. */
async function copyIn(ctx: ApplyContext, kind: "brand-kits" | "references", id: string, names: string[], bin: string) {
  if (!names.length) return { assets: [] as MediaAsset[], notes: [] as string[] };
  const files = await Promise.all(names.map((name) => fetchItemFile(kind, id, name)));
  const { assets, failed } = await importFiles(files);
  if (assets.length) {
    const binId = binFor(ctx, bin);
    ctx.commit({ type: "addAssets", assets: assets.map((a) => ({ ...a, binId })) });
  }
  return { assets, notes: failed.map((f) => `${f.name} was not copied in: ${f.reason}`) };
}

export async function applyBrandKit(ctx: ApplyContext, kit: BrandKit): Promise<{ copiedIn: number; notes: string[] }> {
  const names = Object.values(kit.files).filter((n): n is string => typeof n === "string" && n.length > 0);
  // Copied in by an earlier application of the kit: not twice.
  const have = new Set(ctx.project().assets.map((a) => a.name));
  const { assets, notes } = await copyIn(ctx, "brand-kits", kit.id, names.filter((n) => !have.has(n)), "Brand");
  const logo = kit.files.logo ? (ctx.project().assets.find((a) => a.name === kit.files.logo) ?? null) : null;
  const { theme, notes: themeNotes } = kitTheme(themeOf(ctx.project()), kit);
  ctx.commit({ type: "setTheme", theme, restyle: true });
  ctx.commit({
    type: "setBrief",
    patch: kitBrief(ctx.project().brief, kit, logo?.id ?? null),
    decision: `Brand kit ${kit.name} (version ${kit.version}) applied.`,
  });
  return { copiedIn: assets.length, notes: [...notes, ...themeNotes] };
}

export function applyRecipe(ctx: ApplyContext, recipe: Recipe): void {
  ctx.commit({ type: "setBrief", patch: recipeBrief(ctx.project().brief, recipe), decision: `Recipe ${recipe.name} (version ${recipe.version}) applied.` });
}

export function applyLook(ctx: ApplyContext, look: Look): void {
  ctx.commit({ type: "setTheme", theme: look.theme, restyle: true });
  const brief = ctx.project().brief;
  ctx.commit({ type: "setBrief", patch: { sources: { ...brief.sources, look: { id: look.id, name: look.name, version: look.version } } } });
}

export async function attachReference(ctx: ApplyContext, ref: WorkspaceReference, note?: string): Promise<{ notes: string[] }> {
  const { assets, notes } = ref.file ? await copyIn(ctx, "references", ref.id, [ref.file], "References") : { assets: [], notes: [] };
  const entry: BriefReference = { id: crypto.randomUUID(), assetId: assets[0]?.id ?? null, url: ref.url, note: note ?? (ref.note || ref.name) };
  ctx.commit({
    type: "setBrief",
    patch: { references: [...ctx.project().brief.references, entry] },
    decision: `Reference ${ref.name} attached.`,
  });
  return { notes };
}

/** The project's look, as the Studio keeps one. */
export function lookFromProject(project: Project, id: string, name: string): Omit<Look, "version" | "updatedAt"> {
  const theme = themeOf(project);
  return { id, name, description: `Saved from ${project.name}. ${theme.description}`, theme: { ...theme, id, name } };
}
