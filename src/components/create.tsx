/**
 * Create: the front door. One instruction, the footage, and the recipe, brand
 * kit and look to start from. Start makes the project, imports the footage,
 * writes the brief and opens the editor with the Director already on it.
 *
 * The editor's heavy parts — mediabunny, the import pipeline — are pulled in
 * when Start is pressed, not when this page is drawn: someone who came to
 * record should not download an encoder they will not run.
 */

import { useEffect, useRef, useState } from "react";
import { Film, LoaderCircle, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { RECIPES } from "@/editor/recipes";
import { THEMES } from "@/editor/themes";
import type { BrandKit, Look, Project, Recipe } from "@/editor/types";
import { listItems } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const selectClass = "h-9 rounded-lg border bg-card px-2 text-sm";

export function Create({ onStart, onRecord }: { onStart: (project: Project, request: string | null) => void; onRecord: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [recipeId, setRecipeId] = useState<string>(RECIPES[0]!.id);
  const [kitId, setKitId] = useState("");
  const [lookId, setLookId] = useState("");
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [looks, setLooks] = useState<Look[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>(RECIPES);
  const [busy, setBusy] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listItems("brand-kits").then(setKits).catch(() => setKits([]));
    void listItems("looks").then(setLooks).catch(() => setLooks([]));
    void listItems("recipes")
      .then((saved) => setRecipes([...RECIPES, ...saved]))
      .catch(() => setRecipes(RECIPES));
  }, []);

  const add = (picked: FileList | null) => {
    if (!picked?.length) return;
    setFiles((previous) => [...previous, ...Array.from(picked)]);
  };

  const start = async () => {
    const instruction = prompt.trim();
    if (!instruction && files.length === 0) {
      toast.error("Say what you want to make, or add some footage.");
      return;
    }
    try {
      setBusy("Making the project…");
      const [{ createProject, mediaClip, reduce }, { saveProject }, media, workspaceApply] = await Promise.all([
        import("@/editor/project"),
        import("@/editor/persistence"),
        import("@/editor/media"),
        import("@/editor/workspace-apply"),
      ]);
      const name = instruction ? instruction.replace(/\s+/g, " ").slice(0, 48) : (files[0]?.name ?? "New project");
      let project = createProject(name);
      const ctx = { project: () => project, commit: (action: Parameters<typeof reduce>[1]) => void (project = reduce(project, action)) };

      if (files.length) {
        const { assets, failed } = await media.importFiles(files, (p) => setBusy(`Importing ${p.name} — ${p.stage}…`));
        for (const f of failed) toast.error(`${f.name}: ${f.reason}`);
        if (assets.length) {
          ctx.commit({ type: "addAssets", assets });
          let at = 0;
          for (const asset of assets) {
            const track = project.tracks.find((t) => t.kind === (asset.hasVideo ? "video" : "audio"));
            if (!track) continue;
            ctx.commit({ type: "addClip", trackId: track.id, clip: mediaClip(asset, at) });
            at += asset.durationSec || 0;
          }
        }
      }

      setBusy("Writing the brief…");
      const recipe = recipes.find((r) => r.id === recipeId);
      if (recipe) workspaceApply.applyRecipe(ctx, recipe);
      const look = looks.find((l) => l.id === lookId);
      if (look) workspaceApply.applyLook(ctx, look);
      else if (lookId.startsWith("theme:")) {
        const theme = THEMES.find((t) => t.id === lookId.slice("theme:".length));
        if (theme) ctx.commit({ type: "setTheme", theme, restyle: true });
      }
      const kit = kits.find((k) => k.id === kitId);
      if (kit) {
        setBusy(`Applying ${kit.name}…`);
        await workspaceApply.applyBrandKit(ctx, kit);
      }
      if (instruction) ctx.commit({ type: "setBrief", patch: { goal: instruction }, decision: "Made from Create." });

      await saveProject(project);
      onStart(project, instruction || null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the project.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl py-10">
      <h1 className="text-2xl font-bold tracking-tight">What do you want to make?</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Say it in a line. Add the footage, or record it. The director takes it from there — and asks before the big decisions.
      </p>

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="mt-4 resize-none text-sm"
        placeholder="“A five-minute explainer of how our referral programme works, for the website — side panel, our brand.”"
      />

      <div
        className={cn("mt-3 rounded-xl border border-dashed p-4 text-center", files.length === 0 && "py-8")}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          add(e.dataTransfer.files);
        }}
      >
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">Drop footage here</p>
        ) : (
          <ul className="space-y-1 text-left">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-xs">
                <Film className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.name}</span>
                <span className="ml-auto shrink-0 font-mono text-muted-foreground">{formatDuration(0) === "" ? "" : `${Math.round(f.size / 1e6)} MB`}</span>
                <button className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-center gap-2">
          <input ref={picker} type="file" multiple hidden onChange={(e) => add(e.target.files)} />
          <Button variant="secondary" size="sm" onClick={() => picker.current?.click()}>
            <Upload className="size-3.5" />
            Choose files
          </Button>
          <Button variant="ghost" size="sm" onClick={onRecord}>
            Record instead
          </Button>
        </div>
      </div>

      <h2 className="mt-6 text-sm font-semibold">What kind of video?</h2>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {recipes.map((r) => (
          <button
            key={r.id}
            onClick={() => setRecipeId(r.id)}
            className={cn(
              "rounded-xl border p-3 text-left transition-colors hover:border-foreground/30",
              recipeId === r.id && "border-primary bg-primary/5",
            )}
          >
            <span className="text-sm font-semibold">{r.name}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{r.description}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select className={selectClass} value={kitId} onChange={(e) => setKitId(e.target.value)}>
          <option value="">No brand kit</option>
          {kits.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
        <select className={selectClass} value={lookId} onChange={(e) => setLookId(e.target.value)}>
          <option value="">Look: the director chooses</option>
          {looks.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          {THEMES.map((t) => (
            <option key={t.id} value={`theme:${t.id}`}>
              {t.name}
            </option>
          ))}
        </select>
        <Button className="ml-auto h-9 px-5" disabled={Boolean(busy)} onClick={() => void start()}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {busy ?? "Start"}
        </Button>
      </div>
    </div>
  );
}
