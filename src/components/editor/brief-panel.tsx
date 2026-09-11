/**
 * The brief and the theme, where the client can see what the agent was told
 * and change it. It is the same document the agent reads with get_brief, so a
 * line typed here reaches the next agent session too.
 */

import { useEffect, useState } from "react";
import type { Action } from "@/editor/project";
import { THEMES, themeById } from "@/editor/themes";
import { RECIPES } from "@/editor/recipes";
import { applyBrandKit, applyRecipe, attachReference, lookFromProject, type ApplyContext } from "@/editor/workspace-apply";
import { listItems, newItemId, saveItem } from "@/lib/workspace";
import type { BrandKit, Recipe, WorkspaceReference } from "@/editor/types";
import { toast } from "sonner";
import type { Brief, LayoutStyle, Project, Theme } from "@/editor/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const LAYOUTS: [LayoutStyle, string][] = [
  ["side-panel", "Speaker in a side panel"],
  ["b-roll", "Full frame, graphics as B-roll"],
  ["pip", "Speaker picture-in-picture"],
  ["lower-thirds", "Lower thirds only"],
  ["graphics-only", "Graphics only"],
];

const selectClass = "h-6 w-full rounded-md border bg-background px-1 text-[10px]";

function Swatches({ theme }: { theme: Theme }) {
  const p = theme.palette;
  return (
    <div className="flex items-center gap-1">
      {[p.background, p.surface, p.text, p.muted, p.accent, p.positive].map((c, i) => (
        <span key={i} className="size-4 rounded-sm border" style={{ background: c }} title={c} />
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function BriefPanel({
  project,
  dispatch,
 onCompareLooks, studio,}: {
  project: Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onCompareLooks?: () => void;
  /** The live project and one undo step, so applying a Studio item is one step. */
  studio?: ApplyContext;
}) {
  const b = project.brief;
  const theme = project.theme;
  const builtIn = theme ? THEMES.some((t) => t.id === theme.id) : false;
  const [reference, setReference] = useState("");
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [saved, setSaved] = useState<Recipe[]>([]);
  const [refs, setRefs] = useState<WorkspaceReference[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void listItems("brand-kits").then(setKits).catch(() => setKits([]));
    void listItems("recipes").then(setSaved).catch(() => setSaved([]));
    void listItems("references").then(setRefs).catch(() => setRefs([]));
  }, []);
  const sources = b.sources ?? {};
  const kitNow = sources.brandKit ? kits.find((k) => k.id === sources.brandKit!.id) : undefined;
  const kitBehind = kitNow && sources.brandKit && kitNow.version > sources.brandKit.version ? kitNow : null;

  /** Every apply is the same: one undo step, and what it did in a toast. */
  const run = async (what: string, apply: (ctx: ApplyContext) => Promise<unknown> | unknown) => {
    if (!studio) return;
    setBusy(what);
    try {
      await apply(studio);
      toast.success(`${what} — one undo step`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not apply ${what}.`);
    } finally {
      setBusy(null);
    }
  };
  const set = (patch: Extract<Action, { type: "setBrief" }>["patch"]) => dispatch({ type: "setBrief", patch }, true);
  const images = project.assets.filter((a) => a.kind === "image");

  return (
    <div className="h-full min-h-0 space-y-3 overflow-y-auto p-2">
      <section className="space-y-1.5">
        <div className="flex items-center">
          <Label className="text-[11px] font-medium">Theme</Label>
          {onCompareLooks && (
            <button className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={onCompareLooks}>
              Compare looks
            </button>
          )}
        </div>
        <select
          className={selectClass}
          value={theme?.id ?? ""}
          onChange={(e) => e.target.value && dispatch({ type: "setTheme", theme: themeById(e.target.value), restyle: true })}
        >
          <option value="" disabled>
            Not chosen yet
          </option>
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {theme && !builtIn && <option value={theme.id}>{theme.name} (custom)</option>}
        </select>
        {theme ? (
          <div className="space-y-1">
            <Swatches theme={theme} />
            <p className="text-[10px] leading-snug text-muted-foreground">{theme.description}</p>
            <p className="truncate text-[10px] text-muted-foreground" title={`${theme.fonts.display} / ${theme.fonts.body}`}>
              {theme.fonts.display.split(",")[0]} · {theme.fonts.body.split(",")[0]}
            </p>
          </div>
        ) : (
          <p className="text-[10px] leading-snug text-muted-foreground">
            Pick one here, or ask the agent to show a few on a frame of the video (preview_themes).
          </p>
        )}
      </section>

      {studio && (
        <section className="space-y-1.5">
          <div className="flex items-center">
            <Label className="text-[11px] font-medium">From the Studio</Label>
            {busy && <span className="ml-auto text-[10px] text-muted-foreground">{busy}…</span>}
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {[
              sources.brandKit ? `Brand kit ${sources.brandKit.name} v${sources.brandKit.version}` : null,
              sources.recipe ? `recipe ${sources.recipe.name}` : null,
              sources.look ? `look ${sources.look.name}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Nothing applied yet. What comes in is copied, so editing it in the Studio later leaves this video alone."}
          </p>
          {kitBehind && (
            <button
              className="w-full rounded-md border border-amber-400/40 bg-amber-400/10 px-1.5 py-1 text-left text-[10px] text-amber-500"
              onClick={() => void run(`${kitBehind.name} v${kitBehind.version}`, (ctx) => applyBrandKit(ctx, kitBehind))}
            >
              {kitBehind.name} has been edited since — now v{kitBehind.version}. Apply the update.
            </button>
          )}
          <div className="grid gap-1">
            <select
              className={selectClass}
              value=""
              disabled={Boolean(busy) || kits.length === 0}
              onChange={(e) => {
                const kit = kits.find((k) => k.id === e.target.value);
                if (kit) void run(`Brand kit ${kit.name}`, (ctx) => applyBrandKit(ctx, kit));
              }}
            >
              <option value="">{kits.length ? "Apply a brand kit…" : "No brand kits in the Studio"}</option>
              {kits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} · v{k.version}
                </option>
              ))}
            </select>
            <select
              className={selectClass}
              value=""
              disabled={Boolean(busy)}
              onChange={(e) => {
                const recipe = [...RECIPES, ...saved].find((r) => r.id === e.target.value);
                if (recipe) void run(`Recipe ${recipe.name}`, (ctx) => applyRecipe(ctx, recipe));
              }}
            >
              <option value="">Use a recipe…</option>
              {[...RECIPES, ...saved].map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select
              className={selectClass}
              value=""
              disabled={Boolean(busy) || refs.length === 0}
              onChange={(e) => {
                const ref = refs.find((r) => r.id === e.target.value);
                if (ref) void run(`Reference ${ref.name}`, (ctx) => attachReference(ctx, ref));
              }}
            >
              <option value="">{refs.length ? "Add a reference…" : "No references in the Studio"}</option>
              {refs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button
              className="text-left text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                const name = `${project.name} look`;
                void saveItem("looks", lookFromProject(project, newItemId(name), name))
                  .then((look) => toast.success(`Saved “${look.name}” to the Studio`))
                  .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save the look."));
              }}
            >
              Save this look to the Studio
            </button>
          </div>
        </section>
      )}

      <section className="space-y-1.5">
        <Label className="text-[11px] font-medium">Brief</Label>
        <Field label="Goal — what should it achieve?">
          <Textarea rows={2} className="min-h-0 text-[10px]" value={b.goal} onChange={(e) => set({ goal: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-1">
          <Field label="Audience">
            <Input className="h-6 text-[10px]" value={b.audience} onChange={(e) => set({ audience: e.target.value })} />
          </Field>
          <Field label="Platform">
            <Input className="h-6 text-[10px]" value={b.platform} placeholder="YouTube, Reels…" onChange={(e) => set({ platform: e.target.value })} />
          </Field>
          <Field label="Tone">
            <Input className="h-6 text-[10px]" value={b.tone} onChange={(e) => set({ tone: e.target.value })} />
          </Field>
          <Field label="On-screen language">
            <Input className="h-6 text-[10px]" value={b.language} onChange={(e) => set({ language: e.target.value })} />
          </Field>
        </div>
        <Field label="Layout">
          <select className={selectClass} value={b.layout ?? ""} onChange={(e) => set({ layout: (e.target.value || null) as LayoutStyle | null })}>
            <option value="">Not decided</option>
            {LAYOUTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Captions">
          <select className={selectClass} value={b.captions ?? ""} onChange={(e) => set({ captions: (e.target.value || null) as Brief["captions"] })}>
            <option value="">Not decided</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      </section>

      <section className="space-y-1.5">
        <Label className="text-[11px] font-medium">Brand</Label>
        <div className="grid grid-cols-2 gap-1">
          <Field label="Name">
            <Input className="h-6 text-[10px]" value={b.brand.name} onChange={(e) => set({ brand: { name: e.target.value } })} />
          </Field>
          <Field label="Logo">
            <select className={selectClass} value={b.brand.logoAssetId ?? ""} onChange={(e) => set({ brand: { logoAssetId: e.target.value || null } })}>
              <option value="">None</option>
              {images.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              {b.brand.logoAssetId && !images.some((a) => a.id === b.brand.logoAssetId) && (
                <option value={b.brand.logoAssetId}>Missing asset</option>
              )}
            </select>
          </Field>
        </div>
        <Field label="Colours, comma separated">
          <Input
            className="h-6 font-mono text-[10px]"
            value={b.brand.colors.join(", ")}
            placeholder="#0E7C5A, #F2B705"
            onChange={(e) => set({ brand: { colors: e.target.value.split(",").map((c) => c.trim()).filter(Boolean) } })}
          />
        </Field>
      </section>

      <section className="space-y-1.5">
        <Label className="text-[11px] font-medium">References</Label>
        {b.references.length === 0 && <p className="text-[10px] text-muted-foreground">None yet.</p>}
        {b.references.map((r) => (
          <div key={r.id} className="flex items-start gap-1 text-[10px]">
            <span className="min-w-0 flex-1">
              {r.note}
              {(r.url || r.assetId) && (
                <span className="block truncate text-muted-foreground">
                  {r.url ?? project.assets.find((a) => a.id === r.assetId)?.name ?? "missing asset"}
                </span>
              )}
            </span>
            <button
              className="text-muted-foreground hover:text-foreground"
              title="Remove"
              onClick={() => set({ references: b.references.filter((x) => x.id !== r.id) })}
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex gap-1">
          <Input className="h-6 text-[10px]" value={reference} placeholder="A link, or what to take from a reference" onChange={(e) => setReference(e.target.value)} />
          <Button
            size="sm"
            variant="secondary"
            className="h-6 text-[10px]"
            disabled={!reference.trim()}
            onClick={() => {
              const text = reference.trim();
              const url = /^https?:\/\//.test(text) ? text : null;
              set({ references: [...b.references, { id: crypto.randomUUID(), assetId: null, url, note: url ? "" : text }] });
              setReference("");
            }}
          >
            Add
          </Button>
        </div>
      </section>

      <section className="space-y-1.5">
        <Label className="text-[11px] font-medium">Rules, one per line</Label>
        <Textarea
          rows={3}
          className="min-h-0 text-[10px]"
          value={b.rules.join("\n")}
          placeholder="Numbers on screen are checked with me first"
          onChange={(e) => set({ rules: e.target.value.split("\n") })}
        />
      </section>

      {b.decisions.length > 0 && (
        <section className="space-y-1">
          <Label className="text-[11px] font-medium">Decisions</Label>
          {[...b.decisions].reverse().map((d, i) => (
            <p key={i} className="text-[10px] leading-snug">
              <span className="text-muted-foreground">{new Date(d.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })} · </span>
              {d.text}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
