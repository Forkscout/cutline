/**
 * Image: a still drawn from a prompt by the project's image service, in a
 * saved look, imported into an Images bin and placed as B-roll. A look is the
 * pinned model, the words added to every subject, a negative prompt, a size,
 * steps, a seed and a motion; each still records how it was drawn, so another
 * take matches the first.
 */

import { useEffect, useMemo, useState } from "react";
import { ImageIcon, LoaderCircle, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { KEN_BURNS, type ImagePlacement } from "@/editor/image";
import { imageSizeFor, licenceOf } from "@/editor/image-models";
import { importFiles } from "@/editor/media";
import type { Action } from "@/editor/project";
import type { GeneratedImage, ImageStyle, KenBurns, MediaAsset, Project } from "@/editor/types";
import { generateImage, serviceFor, type ServiceInUse } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface Remembered {
  styleId?: string;
  look?: string;
  negative?: string;
  motion?: KenBurns;
}

const storageKey = (projectId: string) => `cutline:image:${projectId}`;

function remembered(projectId: string): Remembered {
  try {
    return JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

const MOTION_LABEL: Record<KenBurns, string> = {
  "push-in": "Slow push in",
  "pull-out": "Slow pull out",
  "pan-left": "Pan left",
  "pan-right": "Pan right",
  none: "Still",
};

/** The words a still was drawn with beyond its subject: the look. */
const lookOf = (g: GeneratedImage) => g.sentPrompt.slice(g.prompt.length).replace(/^[.\s]+/, "");

export function ImagePanel({
  project,
  time,
  dispatch,
  onOpenServices,
  onPlace,
}: {
  project: Project;
  time: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onOpenServices: () => void;
  /** Adds a generated still to the project, and to the timeline when a placement is given. */
  onPlace: (asset: MediaAsset, place: ImagePlacement | null) => void;
}) {
  const saved = useMemo(() => remembered(project.id), [project.id]);
  const frame = useMemo(() => imageSizeFor(project), [project]);
  const [service, setService] = useState<ServiceInUse | null | undefined>(undefined);
  const [styleId, setStyleId] = useState(saved.styleId ?? "");
  const style = project.imageStyles.find((s) => s.id === styleId);
  const [subject, setSubject] = useState("");
  const [look, setLook] = useState(saved.look ?? "");
  const [negative, setNegative] = useState(saved.negative ?? "");
  const [size, setSize] = useState(`${frame.width}x${frame.height}`);
  const [seed, setSeed] = useState("");
  const [steps, setSteps] = useState("");
  const [motion, setMotion] = useState<KenBurns>(saved.motion ?? "push-in");
  const [place, setPlace] = useState(true);
  const [duration, setDuration] = useState(5);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const preferred = project.services.image;

  useEffect(() => {
    let live = true;
    setService(undefined);
    void serviceFor("image", preferred).then((found) => {
      if (live) setService(found);
    });
    return () => {
      live = false;
    };
  }, [preferred]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(project.id), JSON.stringify({ styleId, look, negative, motion }));
    } catch {
      // A private window: the choices last as long as the panel.
    }
  }, [project.id, styleId, look, negative, motion]);

  const [width, height] = size.split("x").map(Number) as [number, number];
  // A look draws with the model it was saved with, whatever the service's default is now.
  const model = style?.model ?? service?.model ?? "";
  const providerId = style?.providerId ?? service?.providerId;
  const licence = licenceOf(model, service?.local ?? false);
  const sizes = [...new Set([`${frame.width}x${frame.height}`, "1024x1024", (() => { const t = imageSizeFor({ width: 9, height: 16 }); return `${t.width}x${t.height}`; })(), ...(style ? [`${style.width}x${style.height}`] : [])])];

  const choose = (id: string) => {
    setStyleId(id);
    const chosen = project.imageStyles.find((s) => s.id === id);
    if (!chosen) return;
    setLook(chosen.prompt);
    setNegative(chosen.negativePrompt ?? "");
    setSize(`${chosen.width}x${chosen.height}`);
    setSeed(chosen.seed !== undefined ? String(chosen.seed) : "");
    setSteps(chosen.steps !== undefined ? String(chosen.steps) : "");
    setMotion(chosen.motion ?? "push-in");
  };

  const differs = Boolean(
    style &&
      (look.trim() !== style.prompt ||
        negative.trim() !== (style.negativePrompt ?? "") ||
        width !== style.width ||
        height !== style.height ||
        (steps.trim() ? Number(steps) : undefined) !== style.steps ||
        (seed.trim() ? Number(seed) : undefined) !== style.seed ||
        motion !== (style.motion ?? "push-in")),
  );

  const saveStyle = (base: ImageStyle | undefined, name: string) => {
    if (!model || !look.trim() || !name.trim()) return;
    const now = Date.now();
    const next: ImageStyle = {
      id: base?.id ?? crypto.randomUUID(),
      name: name.trim(),
      ...(providerId ? { providerId } : {}),
      model,
      prompt: look.trim(),
      ...(negative.trim() ? { negativePrompt: negative.trim() } : {}),
      width,
      height,
      ...(steps.trim() ? { steps: Number(steps) } : {}),
      ...(base?.guidance !== undefined ? { guidance: base.guidance } : {}),
      ...(base?.sampler ? { sampler: base.sampler } : {}),
      ...(seed.trim() ? { seed: Number(seed) } : {}),
      motion,
      ...(base?.notes ? { notes: base.notes } : {}),
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
    };
    dispatch({ type: "setImageStyle", style: next });
    setStyleId(next.id);
    setNaming(null);
    toast.success(base ? `${next.name} updated` : `${next.name} saved`, {
      description: base ? "New images use these settings; images already drawn keep theirs." : "Every image drawn in this look uses these settings.",
    });
  };

  const last = lastId ? project.assets.find((a) => a.id === lastId) : undefined;
  const lastMade = last?.generated?.kind === "image" ? last.generated : undefined;

  /** Draws a still: from the fields, or another take of one already drawn. */
  const draw = async (again?: { asset: MediaAsset; made: GeneratedImage }) => {
    if (!service) return;
    const made = again?.made;
    const what = made ? made.prompt : subject.trim();
    if (!what) return;
    const words = made ? lookOf(made) : look.trim();
    const sentPrompt = words ? `${what}. ${words}` : what;
    const w = made?.width ?? width;
    const h = made?.height ?? height;
    const neg = made ? made.negativePrompt : negative.trim() || undefined;
    const drawSteps = made ? made.steps : steps.trim() ? Number(steps) : undefined;
    const drawSeed = made ? undefined : seed.trim() ? Number(seed) : undefined;
    const drawModel = made?.model ?? (style ? model : undefined);
    const drawProvider = made?.providerId ?? providerId;
    const name = what.replace(/\s+/g, " ").slice(0, 40);
    setBusy(true);
    try {
      const picture = await generateImage(
        {
          prompt: sentPrompt,
          ...(neg ? { negativePrompt: neg } : {}),
          width: w,
          height: h,
          ...(drawSeed !== undefined ? { seed: drawSeed } : {}),
          ...(drawSteps !== undefined ? { steps: drawSteps } : {}),
          ...(style?.guidance !== undefined && !made ? { guidance: style.guidance } : {}),
          ...(style?.sampler && !made ? { sampler: style.sampler } : {}),
          ...(drawModel && drawModel !== "current" ? { model: drawModel } : {}),
          ...(drawProvider ? { providerId: drawProvider } : {}),
          projectId: project.id,
        },
        name,
      );
      const { assets, failed } = await importFiles([picture.file]);
      const asset = assets[0];
      if (!asset) throw new Error(`The image came back but could not be imported: ${failed[0]?.reason ?? "no reason given"}`);
      const styled = made?.styleId ? { styleId: made.styleId, ...(made.style ? { style: made.style } : {}) } : style ? { styleId: style.id, style: style.name } : {};
      const generated: GeneratedImage = {
        kind: "image",
        prompt: what,
        sentPrompt,
        ...(neg ? { negativePrompt: neg } : {}),
        ...styled,
        seed: picture.seed,
        width: w,
        height: h,
        ...(drawSteps !== undefined ? { steps: drawSteps } : {}),
        providerId: picture.providerId,
        service: picture.provider,
        model: picture.model,
        ...(picture.modelUsed && picture.modelUsed !== picture.model ? { modelUsed: picture.modelUsed } : {}),
        ...(again ? { variationOf: again.asset.id } : {}),
        createdAt: Date.now(),
        by: "user",
      };
      onPlace({ ...asset, name, generated }, place ? { start: time, duration, motion } : null);
      setLastId(asset.id);
      toast.success("Image added", { description: place ? `As B-roll from ${time.toFixed(1)} s for ${duration} s, and in the Images bin.` : "In the Images bin." });
    } catch (err) {
      toast.error("Could not draw the image", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const field = "h-7 w-full rounded-md border bg-transparent px-1 text-[11px]";

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto px-2 pb-2">
      <div className="flex items-center gap-2 rounded-lg border p-2">
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium">Images</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {service === undefined ? "Checking…" : service ? `${service.name} · ${model}` : "No image service connected"}
          </div>
        </div>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onOpenServices}>
          <Settings2 className="size-3" />
          Services
        </Button>
      </div>

      {service === null ? (
        <p className="px-1 text-[11px] leading-snug text-muted-foreground">
          Connect an image service in Services. Draw Things on this Mac is free and offline: turn on its API server in the app, then add it with the Draw
          Things preset. For client work, draw with an Apache 2.0 model — Z-Image Turbo, FLUX.2 [klein] 4B or Qwen-Image.
        </p>
      ) : (
        <>
          {licence && !licence.commercial && (
            <p className="rounded-md border border-amber-500/40 p-1.5 text-[10px] leading-snug text-amber-500">
              {model} is under the {licence.name}: its images are not for commercial or client work. Z-Image Turbo, FLUX.2 [klein] 4B and Qwen-Image are Apache 2.0.
            </p>
          )}

          <div className="space-y-1">
            <span className="flex items-center text-[10px] text-muted-foreground">
              Look
              {naming === null && (
                <button className="ml-auto hover:text-foreground" disabled={!look.trim()} onClick={() => setNaming("")}>
                  {style ? "Save as a new look…" : "Save as a look…"}
                </button>
              )}
            </span>
            <select className={field} value={style ? styleId : ""} onChange={(e) => choose(e.target.value)}>
              <option value="">No saved look</option>
              {project.imageStyles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {naming !== null && (
              <div className="flex gap-1">
                <Input
                  autoFocus
                  className="h-7 text-[11px]"
                  placeholder="Documentary B-roll"
                  value={naming}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveStyle(undefined, naming);
                    if (e.key === "Escape") setNaming(null);
                  }}
                />
                <Button size="sm" className="h-7 px-2 text-[11px]" disabled={!naming.trim()} onClick={() => saveStyle(undefined, naming)}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setNaming(null)}>
                  Cancel
                </Button>
              </div>
            )}
            {style && differs && (
              <p className="text-[10px] leading-snug text-muted-foreground">
                These settings differ from {style.name}'s, so images drawn now will not match the others.{" "}
                <button className="text-primary hover:underline" onClick={() => saveStyle(style, style.name)}>
                  Save them to {style.name}
                </button>{" "}
                or{" "}
                <button className="text-primary hover:underline" onClick={() => choose(style.id)}>
                  put {style.name}'s back
                </button>
                .
              </p>
            )}
          </div>

          <label className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Subject · what this image shows</span>
            <Textarea value={subject} onChange={(e) => setSubject(e.target.value)} rows={3} className="text-xs" placeholder="A chai stall on a Mumbai street at dawn, steam rising" />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Look words · added to every subject</span>
            <Textarea
              value={look}
              onChange={(e) => setLook(e.target.value)}
              rows={2}
              className="text-xs"
              placeholder="Cinematic still, soft natural light, muted teal and amber, 35mm, shallow depth of field"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Avoid</span>
            <Input className="h-7 text-[11px]" value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="text, watermark, logo, extra fingers" />
          </label>

          <div className="grid grid-cols-3 gap-1.5">
            <label className="col-span-3 space-y-1">
              <span className="text-[10px] text-muted-foreground">Size</span>
              <select className={field} value={size} onChange={(e) => setSize(e.target.value)}>
                {sizes.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("x", " × ")}
                    {s === `${frame.width}x${frame.height}` ? " · the sequence's shape" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-muted-foreground">Seed</span>
              <Input className="h-7 text-[11px]" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))} placeholder="random" />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-muted-foreground">Steps</span>
              <Input className="h-7 text-[11px]" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value.replace(/\D/g, ""))} placeholder="model's" />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-muted-foreground">Motion</span>
              <select className={field} value={motion} onChange={(e) => setMotion(e.target.value as KenBurns)}>
                {KEN_BURNS.map((m) => (
                  <option key={m} value={m}>
                    {MOTION_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex items-center gap-2 text-[11px]">
            <Switch checked={place} onCheckedChange={setPlace} />
            B-roll at the playhead · {time.toFixed(1)} s for
            <Input
              className="h-6 w-12 px-1 text-[11px]"
              inputMode="decimal"
              value={duration}
              disabled={!place}
              onChange={(e) => setDuration(Math.min(60, Math.max(0.5, Number(e.target.value) || 5)))}
            />
            s
          </label>

          <Button size="sm" className="h-8 text-xs" disabled={!service || !subject.trim() || busy} onClick={() => void draw()}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />}
            {busy ? "Drawing… a local model can take a minute" : "Generate image"}
          </Button>

          {last && lastMade && (
            <div className="space-y-1 rounded-lg border p-1.5">
              {last.thumbnail && <img src={last.thumbnail} alt="" className="aspect-video w-full rounded object-cover" />}
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="truncate">
                  Seed {lastMade.seed} · {lastMade.modelUsed ?? lastMade.model}
                </span>
                <button className="ml-auto shrink-0 text-primary hover:underline" onClick={() => setSeed(String(lastMade.seed))}>
                  Keep this seed
                </button>
                <button className="shrink-0 text-primary hover:underline" disabled={busy} onClick={() => void draw({ asset: last, made: lastMade })}>
                  Another take
                </button>
              </div>
            </div>
          )}

          <p className="text-[10px] leading-snug text-muted-foreground">
            Each image keeps how it was drawn — subject, look, seed and model — in the Inspector, so another take matches. Look at it on the timeline before
            keeping it.
          </p>
        </>
      )}
    </div>
  );
}
