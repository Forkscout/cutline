import { useState } from "react";
import { ChevronDown, ChevronUp, Diamond, Plus, Trash2, X } from "lucide-react";
import { EFFECTS, createEffect, effectSpec } from "@/editor/effects";
import { parseFigure } from "@/editor/counter";
import { animatedProperties, keyframesFor } from "@/editor/keyframes";
import type { Action } from "@/editor/project";
import { assetOf, findClip } from "@/editor/project";
import { BACKGROUND_PRESETS, SIZE_PRESETS } from "@/editor/presets";
import {
  DEFAULT_COLOR,
  type BlendMode,
  type ClipRef,
  type EffectType,
  type Project,
  type TextAnimation,
  type TransitionType,
} from "@/editor/types";
import { ColorField, Field, NumberSlider, Toggle } from "@/components/editor/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const BLEND_MODES: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "dissolve", label: "Cross dissolve" },
  { value: "fadeToBlack", label: "Dip to black" },
  { value: "fadeToWhite", label: "Dip to white" },
  { value: "wipeLeft", label: "Wipe left" },
  { value: "wipeRight", label: "Wipe right" },
  { value: "wipeUp", label: "Wipe up" },
  { value: "wipeDown", label: "Wipe down" },
  { value: "pushLeft", label: "Push left" },
  { value: "pushRight", label: "Push right" },
  { value: "slideUp", label: "Slide up" },
  { value: "slideDown", label: "Slide down" },
  { value: "zoom", label: "Zoom" },
  { value: "blur", label: "Blur" },
];

const TEXT_ANIMATIONS: { value: TextAnimation; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade in" },
  { value: "slideUp", label: "Slide up" },
  { value: "slideLeft", label: "Slide in" },
  { value: "typewriter", label: "Typewriter" },
  { value: "pop", label: "Pop" },
  { value: "scale", label: "Scale up" },
];

export function Inspector({
  project,
  selected,
  time,
  dispatch,
}: {
  project: Project;
  selected: ClipRef | null;
  time: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  const clip = findClip(project, selected);
  const asset = clip ? assetOf(project, clip) : undefined;
  const voiceMade = asset?.generated?.kind === "voice" ? asset.generated : undefined;
  const imageMade = asset?.generated?.kind === "image" ? asset.generated : undefined;
  const localTime = clip ? time - clip.start : 0;
  const [tab, setTab] = useState("transform");

  if (!clip || !selected) return <SceneInspector project={project} dispatch={dispatch} />;

  const t = clip.transform;
  const setT = (patch: Partial<typeof t>, coalesce = false) =>
    dispatch({ type: "setTransform", ref: selected, patch }, coalesce);
  const setColor = (patch: Partial<typeof clip.color>, coalesce = false) =>
    dispatch({ type: "setColor", ref: selected, patch }, coalesce);
  const isVisual = clip.kind !== "media" || Boolean(asset?.hasVideo);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-2.5 py-2">
        <Input
          value={clip.name}
          onChange={(e) => dispatch({ type: "patchClip", ref: selected, patch: { name: e.target.value } })}
          className="h-7 text-xs font-medium"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          {clip.kind} · {clip.duration.toFixed(2)}s
          {asset && ` · ${asset.width}×${asset.height}`}
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-2 mt-2 grid h-8 grid-cols-5">
          <TabsTrigger value="transform" className="text-[10px]">Layer</TabsTrigger>
          <TabsTrigger value="color" className="text-[10px]">Colour</TabsTrigger>
          <TabsTrigger value="effects" className="text-[10px]">FX</TabsTrigger>
          <TabsTrigger value="audio" className="text-[10px]">Audio</TabsTrigger>
          <TabsTrigger value="anim" className="text-[10px]">Anim</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <TabsContent value="transform" className="mt-0 space-y-3">
            {imageMade && (
              <div className="space-y-1 rounded-md border p-2 text-[11px]">
                <div className="font-medium">Generated image{imageMade.style ? ` · ${imageMade.style}` : ""}</div>
                <div className="line-clamp-4 whitespace-pre-wrap">{imageMade.prompt}</div>
                <div className="text-muted-foreground">
                  Seed {imageMade.seed} · {imageMade.modelUsed ?? imageMade.model} · {imageMade.service} · {imageMade.width}×{imageMade.height}
                  {imageMade.steps ? ` · ${imageMade.steps} steps` : ""}
                </div>
                {imageMade.negativePrompt && <div className="text-muted-foreground">Avoid: {imageMade.negativePrompt}</div>}
                <div className="text-[10px] text-muted-foreground">
                  Drawn {new Date(imageMade.createdAt).toLocaleString()} by {imageMade.by === "agent" ? "an agent" : "you"}
                  {imageMade.variationOf ? " · another take of an earlier image" : ""}
                </div>
              </div>
            )}
            {clip.kind === "text" && clip.text && (
              <>
                <Field label="Content">
                  <Textarea
                    value={clip.text.content}
                    rows={3}
                    className="text-xs"
                    onChange={(e) => dispatch({ type: "setText", ref: selected, patch: { content: e.target.value } })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Font">
                    <Select
                      value={clip.text.fontFamily}
                      onValueChange={(v) => dispatch({ type: "setText", ref: selected, patch: { fontFamily: v } })}
                    >
                      <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Inter, system-ui, sans-serif">Inter</SelectItem>
                        <SelectItem value="Georgia, serif">Georgia</SelectItem>
                        <SelectItem value="ui-monospace, monospace">Mono</SelectItem>
                        <SelectItem value="Impact, sans-serif">Impact</SelectItem>
                        <SelectItem value="'Times New Roman', serif">Times</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Weight">
                    <Select
                      value={String(clip.text.fontWeight)}
                      onValueChange={(v) => dispatch({ type: "setText", ref: selected, patch: { fontWeight: Number(v) } })}
                    >
                      <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[300, 400, 500, 600, 700, 800, 900].map((w) => (
                          <SelectItem key={w} value={String(w)}>{w}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <NumberSlider label="Font size" value={clip.text.fontSize} min={10} max={300} step={1}
                  format={(v) => `${Math.round(v)}px`} dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "setText", ref: selected, patch: { fontSize: v } }, c)} />
                <NumberSlider label="Letter spacing" value={clip.text.letterSpacing} min={-20} max={60} step={0.5}
                  dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "setText", ref: selected, patch: { letterSpacing: v } }, c)} />
                <NumberSlider label="Line height" value={clip.text.lineHeight} min={0.8} max={2.5} step={0.05}
                  dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "setText", ref: selected, patch: { lineHeight: v } }, c)} />
                {(clip.text.reveal !== undefined || clip.keyframes.some((k) => k.property === "text.reveal")) && (
                  <NumberSlider label="Lines shown" path="text.reveal" clip={clip} clipRef={selected} localTime={localTime}
                    value={clip.text.reveal ?? clip.text.content.split("\n").length} min={0} max={clip.text.content.split("\n").length} step={0.05}
                    format={(v) => (v >= clip.text!.content.split("\n").length ? "all" : v.toFixed(1))} dispatch={dispatch}
                    onChange={(v, c) => dispatch({ type: "setText", ref: selected, patch: { reveal: v } }, c)} />
                )}
                {(clip.text.counter || parseFigure(clip.text.content)) && (
                  <Toggle label="Count up to this figure" checked={Boolean(clip.text.counter)}
                    onChange={(on) => {
                      const others = clip.keyframes.filter((k) => k.property !== "text.counterValue");
                      if (!on) {
                        const { counter: _counter, counterValue: _counterValue, ...words } = clip.text!;
                        dispatch({ type: "patchClip", ref: selected, patch: { text: words, keyframes: others } });
                        return;
                      }
                      const seconds = Math.min(1.6, clip.duration / 2);
                      dispatch({ type: "patchClip", ref: selected, patch: {
                        text: { ...clip.text!, counter: parseFigure(clip.text!.content)!, counterValue: 1 },
                        keyframes: [...others,
                          { id: crypto.randomUUID(), property: "text.counterValue", time: 0, value: 0, easing: "easeOut" },
                          { id: crypto.randomUUID(), property: "text.counterValue", time: seconds, value: 1, easing: "hold" }],
                      } });
                    }} />
                )}
                {clip.text.counter && (
                  <NumberSlider label="Counted" path="text.counterValue" clip={clip} clipRef={selected} localTime={localTime}
                    value={clip.text.counterValue ?? 1} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} dispatch={dispatch}
                    onChange={(v, c) => dispatch({ type: "setText", ref: selected, patch: { counterValue: v } }, c)} />
                )}
                <ColorField label="Colour" value={clip.text.color}
                  onChange={(v) => dispatch({ type: "setText", ref: selected, patch: { color: v } })} />
                <ColorField label="Stroke" value={clip.text.strokeColor}
                  onChange={(v) => dispatch({ type: "setText", ref: selected, patch: { strokeColor: v } })} />
                <NumberSlider label="Stroke width" value={clip.text.strokeWidth} min={0} max={24} step={0.5}
                  dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "setText", ref: selected, patch: { strokeWidth: v } }, c)} />
                <NumberSlider label="Shadow" value={clip.text.shadowBlur} min={0} max={60} step={1}
                  dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "setText", ref: selected, patch: { shadowBlur: v } }, c)} />
                <div className="grid grid-cols-3 gap-1">
                  {(["left", "center", "right"] as const).map((a) => (
                    <Button key={a} size="sm" className="h-7 text-[10px]"
                      variant={clip.text!.align === a ? "secondary" : "ghost"}
                      onClick={() => dispatch({ type: "setText", ref: selected, patch: { align: a } })}>
                      {a}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-3">
                  <Toggle label="Italic" checked={clip.text.italic}
                    onChange={(v) => dispatch({ type: "setText", ref: selected, patch: { italic: v } })} />
                  <Toggle label="Underline" checked={clip.text.underline}
                    onChange={(v) => dispatch({ type: "setText", ref: selected, patch: { underline: v } })} />
                </div>
                <Separator />
              </>
            )}

            {clip.kind === "shape" && clip.shape && (
              <>
                <Field label="Shape">
                  <Select value={clip.shape.kind}
                    onValueChange={(v) => dispatch({ type: "setShape", ref: selected, patch: { kind: v as never } })}>
                    <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["rectangle", "ellipse", "line", "triangle", "star", "arrow", ...(clip.shape.kind === "path" ? ["path"] : [])].map((k) => (
                        <SelectItem key={k} value={k}>{k}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <ColorField label="Fill" value={clip.shape.fill}
                  onChange={(v) => dispatch({ type: "setShape", ref: selected, patch: { fill: v } })} />
                <ColorField label="Stroke" value={clip.shape.stroke}
                  onChange={(v) => dispatch({ type: "setShape", ref: selected, patch: { stroke: v } })} />
                <NumberSlider label="Stroke width" value={clip.shape.strokeWidth} min={0} max={40} step={1}
                  dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "setShape", ref: selected, patch: { strokeWidth: v } }, c)} />
                <NumberSlider label="Corner radius" value={clip.shape.cornerRadius} min={0} max={100} step={1}
                  dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "setShape", ref: selected, patch: { cornerRadius: v } }, c)} />
                <Separator />
              </>
            )}

            {isVisual && (
              <>
                <NumberSlider label="Position X" path="transform.x" clip={clip} clipRef={selected} localTime={localTime}
                  value={t.x} min={-0.5} max={1.5} step={0.002} defaultValue={0.5}
                  dispatch={dispatch} onChange={(v, c) => setT({ x: v }, c)} />
                <NumberSlider label="Position Y" path="transform.y" clip={clip} clipRef={selected} localTime={localTime}
                  value={t.y} min={-0.5} max={1.5} step={0.002} defaultValue={0.5}
                  dispatch={dispatch} onChange={(v, c) => setT({ y: v }, c)} />
                <NumberSlider label="Scale" path="transform.scale" clip={clip} clipRef={selected} localTime={localTime}
                  value={t.scale} min={0.02} max={4} step={0.01} defaultValue={1}
                  format={(v) => `${Math.round(v * 100)}%`}
                  dispatch={dispatch} onChange={(v, c) => setT({ scale: v }, c)} />
                <div className="grid grid-cols-2 gap-2">
                  <NumberSlider label="Stretch X" value={t.scaleX} min={0.1} max={3} step={0.01} defaultValue={1}
                    dispatch={dispatch} onChange={(v, c) => setT({ scaleX: v }, c)} />
                  <NumberSlider label="Stretch Y" value={t.scaleY} min={0.1} max={3} step={0.01} defaultValue={1}
                    dispatch={dispatch} onChange={(v, c) => setT({ scaleY: v }, c)} />
                </div>
                <NumberSlider label="Rotation" path="transform.rotation" clip={clip} clipRef={selected} localTime={localTime}
                  value={t.rotation} min={-180} max={180} step={0.5} defaultValue={0}
                  format={(v) => `${v.toFixed(1)}°`}
                  dispatch={dispatch} onChange={(v, c) => setT({ rotation: v }, c)} />
                <NumberSlider label="Opacity" path="transform.opacity" clip={clip} clipRef={selected} localTime={localTime}
                  value={t.opacity} min={0} max={1} step={0.01} defaultValue={1}
                  format={(v) => `${Math.round(v * 100)}%`}
                  dispatch={dispatch} onChange={(v, c) => setT({ opacity: v }, c)} />

                <div className="grid grid-cols-2 gap-2">
                  <NumberSlider label="Anchor X" value={t.anchorX} min={0} max={1} step={0.01} defaultValue={0.5}
                    dispatch={dispatch} onChange={(v, c) => setT({ anchorX: v }, c)} />
                  <NumberSlider label="Anchor Y" value={t.anchorY} min={0} max={1} step={0.01} defaultValue={0.5}
                    dispatch={dispatch} onChange={(v, c) => setT({ anchorY: v }, c)} />
                </div>

                <div className="flex gap-3">
                  <Toggle label="Flip H" checked={t.flipH} onChange={(v) => setT({ flipH: v })} />
                  <Toggle label="Flip V" checked={t.flipV} onChange={(v) => setT({ flipV: v })} />
                </div>

                <Field label="Blend mode">
                  <Select value={t.blendMode} onValueChange={(v) => setT({ blendMode: v as BlendMode })}>
                    <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BLEND_MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>

                <Separator />

                <Field label="Frame">
                  <div className="grid grid-cols-2 gap-1">
                    {(["rect", "circle"] as const).map((s) => (
                      <Button key={s} size="sm" className="h-7 text-[10px]"
                        variant={t.shape === s ? "secondary" : "ghost"} onClick={() => setT({ shape: s })}>
                        {s === "rect" ? "Rectangle" : "Circle"}
                      </Button>
                    ))}
                  </div>
                </Field>
                {t.shape === "rect" && (
                  <NumberSlider label="Corner radius" value={t.radius} min={0} max={120} step={1} defaultValue={0}
                    format={(v) => `${Math.round(v)}px`}
                    dispatch={dispatch} onChange={(v, c) => setT({ radius: v }, c)} />
                )}
                <NumberSlider label="Shadow" value={t.shadow} min={0} max={140} step={1} defaultValue={0}
                  dispatch={dispatch} onChange={(v, c) => setT({ shadow: v }, c)} />

                <Separator />
                <Field label="Crop">
                  <div className="grid grid-cols-2 gap-2">
                    {(["top", "right", "bottom", "left"] as const).map((edge) => (
                      <div key={edge} className="space-y-0.5">
                        <span className="text-[10px] text-muted-foreground capitalize">{edge}</span>
                        <Input type="number" min={0} max={45} step={1} className="h-6 text-[11px]"
                          value={Math.round(t.crop[edge] * 100)}
                          onChange={(e) =>
                            setT({ crop: { ...t.crop, [edge]: Math.min(0.45, Math.max(0, Number(e.target.value) / 100)) } })
                          } />
                      </div>
                    ))}
                  </div>
                </Field>

                <Separator />
                <Field label="Mask">
                  <Select value={clip.mask.shape}
                    onValueChange={(v) => dispatch({ type: "setMask", ref: selected, patch: { shape: v as never } })}>
                    <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="rect">Rectangle</SelectItem>
                      <SelectItem value="ellipse">Ellipse</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {clip.mask.shape !== "none" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <NumberSlider label="Mask X" value={clip.mask.x} min={-0.5} max={1.5} step={0.01}
                        dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setMask", ref: selected, patch: { x: v } }, c)} />
                      <NumberSlider label="Mask Y" value={clip.mask.y} min={-0.5} max={1.5} step={0.01}
                        dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setMask", ref: selected, patch: { y: v } }, c)} />
                      <NumberSlider label="Width" value={clip.mask.width} min={0.02} max={2} step={0.01}
                        dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setMask", ref: selected, patch: { width: v } }, c)} />
                      <NumberSlider label="Height" value={clip.mask.height} min={0.02} max={2} step={0.01}
                        dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setMask", ref: selected, patch: { height: v } }, c)} />
                    </div>
                    <NumberSlider label="Feather" value={clip.mask.feather} min={0} max={100} step={1}
                      dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setMask", ref: selected, patch: { feather: v } }, c)} />
                    <NumberSlider label="Mask rotation" value={clip.mask.rotation} min={-180} max={180} step={1}
                      dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setMask", ref: selected, patch: { rotation: v } }, c)} />
                    <Toggle label="Invert mask" checked={clip.mask.invert}
                      onChange={(v) => dispatch({ type: "setMask", ref: selected, patch: { invert: v } })} />
                  </>
                )}

                {clip.kind === "media" && (
                  <>
                    <Separator />
                    <Toggle label="Chroma key" checked={clip.chroma.enabled}
                      onChange={(v) => dispatch({ type: "setChroma", ref: selected, patch: { enabled: v } })} />
                    {clip.chroma.enabled && (
                      <>
                        <ColorField label="Key colour" value={clip.chroma.color}
                          onChange={(v) => dispatch({ type: "setChroma", ref: selected, patch: { color: v } })} />
                        <NumberSlider label="Similarity" value={clip.chroma.similarity} min={0} max={1} step={0.01}
                          dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setChroma", ref: selected, patch: { similarity: v } }, c)} />
                        <NumberSlider label="Smoothness" value={clip.chroma.smoothness} min={0} max={0.6} step={0.01}
                          dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setChroma", ref: selected, patch: { smoothness: v } }, c)} />
                        <NumberSlider label="Spill suppression" value={clip.chroma.spill} min={0} max={1} step={0.01}
                          dispatch={dispatch} onChange={(v, c) => dispatch({ type: "setChroma", ref: selected, patch: { spill: v } }, c)} />
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="color" className="mt-0 space-y-3">
            {(
              [
                ["exposure", "Exposure", -100, 100],
                ["brightness", "Brightness", -100, 100],
                ["contrast", "Contrast", -100, 100],
                ["highlights", "Highlights", -100, 100],
                ["shadows", "Shadows", -100, 100],
                ["whites", "Whites", -100, 100],
                ["blacks", "Blacks", -100, 100],
                ["saturation", "Saturation", -100, 200],
                ["vibrance", "Vibrance", -100, 100],
                ["temperature", "Temperature", -100, 100],
                ["tint", "Tint", -100, 100],
                ["hue", "Hue", -180, 180],
                ["sharpen", "Sharpen", 0, 100],
                ["fade", "Fade", 0, 100],
              ] as const
            ).map(([key, label, min, max]) => (
              <NumberSlider key={key} label={label} path={`color.${key}`} clip={clip} clipRef={selected}
                localTime={localTime} value={clip.color[key]} min={min} max={max} step={1} defaultValue={0}
                format={(v) => v.toFixed(0)} dispatch={dispatch}
                onChange={(v, c) => setColor({ [key]: v }, c)} />
            ))}
            <Button variant="secondary" size="sm" className="h-7 w-full text-[11px]"
              onClick={() => dispatch({ type: "setColor", ref: selected, patch: { ...DEFAULT_COLOR } })}>
              Reset grade
            </Button>
          </TabsContent>

          <TabsContent value="effects" className="mt-0 space-y-3">
            <Select value="" onValueChange={(v) => dispatch({ type: "addEffect", ref: selected, effect: createEffect(v as EffectType) })}>
              <SelectTrigger className="h-7 text-[11px]">
                <span className="flex items-center gap-1.5"><Plus className="size-3" />Add effect</span>
              </SelectTrigger>
              <SelectContent>
                {EFFECTS.map((e) => <SelectItem key={e.type} value={e.type}>{e.label}</SelectItem>)}
              </SelectContent>
            </Select>

            {clip.effects.length === 0 && (
              <p className="text-[11px] text-muted-foreground">No effects on this clip.</p>
            )}

            {clip.effects.map((effect, i) => {
              const spec = effectSpec(effect.type);
              return (
                <div key={effect.id} className="space-y-2 rounded-md border p-2">
                  <div className="flex items-center gap-1">
                    <input type="checkbox" checked={effect.enabled} className="size-3 accent-[var(--primary)]"
                      onChange={(e) => dispatch({ type: "patchEffect", ref: selected, effectId: effect.id, patch: { enabled: e.target.checked } })} />
                    <span className="text-[11px] font-medium">{spec?.label ?? effect.type}</span>
                    <div className="ml-auto flex">
                      <Button variant="ghost" size="icon" className="size-5" disabled={i === 0}
                        onClick={() => dispatch({ type: "reorderEffect", ref: selected, effectId: effect.id, delta: -1 })}>
                        <ChevronUp className="size-3" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-5" disabled={i === clip.effects.length - 1}
                        onClick={() => dispatch({ type: "reorderEffect", ref: selected, effectId: effect.id, delta: 1 })}>
                        <ChevronDown className="size-3" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-5"
                        onClick={() => dispatch({ type: "removeEffect", ref: selected, effectId: effect.id })}>
                        <X className="size-3" />
                      </Button>
                    </div>
                  </div>
                  {spec?.params.map((param) => (
                    <NumberSlider key={param.key} label={param.label}
                      value={effect.params[param.key] ?? param.default}
                      min={param.min} max={param.max} step={param.step} defaultValue={param.default}
                      dispatch={dispatch}
                      onChange={(v, c) =>
                        dispatch({ type: "patchEffect", ref: selected, effectId: effect.id, patch: { params: { [param.key]: v } } }, c)
                      } />
                  ))}
                </div>
              );
            })}
          </TabsContent>

          <TabsContent value="audio" className="mt-0 space-y-3">
            {voiceMade && (
              <div className="space-y-1 rounded-md border p-2 text-[11px]">
                <div className="font-medium">Generated voice{voiceMade.speaker ? ` · ${voiceMade.speaker}` : ""}</div>
                <div className="text-muted-foreground">
                  {voiceMade.voice} · {voiceMade.model} · {voiceMade.service}
                  {voiceMade.speed ? ` · ${voiceMade.speed}×` : ""}
                </div>
                {voiceMade.instructions && <div className="text-muted-foreground">Direction: {voiceMade.instructions}</div>}
                <div className="line-clamp-5 whitespace-pre-wrap rounded border p-1.5">{voiceMade.text}</div>
                <div className="text-[10px] text-muted-foreground">
                  Read {new Date(voiceMade.createdAt).toLocaleString()} by {voiceMade.by === "agent" ? "an agent" : "you"}
                </div>
              </div>
            )}
            {asset?.hasAudio ? (
              <>
                <NumberSlider label="Volume" path="volume" clip={clip} clipRef={selected} localTime={localTime}
                  value={clip.volume} min={0} max={2} step={0.01} defaultValue={1}
                  format={(v) => `${Math.round(v * 100)}%`} dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "patchClip", ref: selected, patch: { volume: v } }, c)} />
                <NumberSlider label="Pan" value={clip.pan} min={-1} max={1} step={0.01} defaultValue={0}
                  format={(v) => (v === 0 ? "centre" : v < 0 ? `${Math.round(-v * 100)}% L` : `${Math.round(v * 100)}% R`)}
                  dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "patchClip", ref: selected, patch: { pan: v } }, c)} />
                <NumberSlider label="Fade in" value={clip.fadeIn} min={0} max={Math.max(0.1, clip.duration / 2)} step={0.05}
                  format={(v) => `${v.toFixed(2)}s`} defaultValue={0} dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "patchClip", ref: selected, patch: { fadeIn: v } }, c)} />
                <NumberSlider label="Fade out" value={clip.fadeOut} min={0} max={Math.max(0.1, clip.duration / 2)} step={0.05}
                  format={(v) => `${v.toFixed(2)}s`} defaultValue={0} dispatch={dispatch}
                  onChange={(v, c) => dispatch({ type: "patchClip", ref: selected, patch: { fadeOut: v } }, c)} />
                <Toggle label="Mute this clip" checked={clip.muted}
                  onChange={(v) => dispatch({ type: "patchClip", ref: selected, patch: { muted: v } })} />
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">This clip has no audio.</p>
            )}

            <Separator />
            <NumberSlider label="Speed" value={clip.speed} min={0.1} max={8} step={0.05} defaultValue={1}
              format={(v) => `${v.toFixed(2)}×`} dispatch={dispatch}
              onChange={(v, c) =>
                dispatch({ type: "patchClip", ref: selected, patch: { speed: v, duration: (clip.duration * clip.speed) / v } }, c)
              } />
            <Toggle label="Reverse" checked={clip.reversed}
              onChange={(v) => dispatch({ type: "patchClip", ref: selected, patch: { reversed: v } })} />
            <Toggle label="Freeze frame" checked={clip.freeze}
              onChange={(v) => dispatch({ type: "patchClip", ref: selected, patch: { freeze: v } })} />
          </TabsContent>

          <TabsContent value="anim" className="mt-0 space-y-3">
            {clip.kind === "text" && (
              <Field label="Text animation">
                <Select value={clip.textAnimation ?? "none"}
                  onValueChange={(v) => dispatch({ type: "patchClip", ref: selected, patch: { textAnimation: v as TextAnimation } })}>
                  <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEXT_ANIMATIONS.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            )}

            {(["in", "out"] as const).map((edge) => {
              const transition = edge === "in" ? clip.transitionIn : clip.transitionOut;
              return (
                <div key={edge} className="space-y-2 rounded-md border p-2">
                  <Label className="text-[11px] font-medium capitalize">Transition {edge}</Label>
                  <Select value={transition.type}
                    onValueChange={(v) => dispatch({ type: "setTransition", ref: selected, edge, patch: { type: v as TransitionType } })}>
                    <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TRANSITIONS.map((t2) => <SelectItem key={t2.value} value={t2.value}>{t2.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {transition.type !== "none" && (
                    <NumberSlider label="Duration" value={transition.duration} min={0.1}
                      max={Math.max(0.2, clip.duration / 2)} step={0.05} format={(v) => `${v.toFixed(2)}s`}
                      dispatch={dispatch}
                      onChange={(v, c) => dispatch({ type: "setTransition", ref: selected, edge, patch: { duration: v } }, c)} />
                  )}
                </div>
              );
            })}

            <Separator />
            <Label className="text-[11px] font-medium">Keyframes</Label>
            {clip.keyframes.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Use the diamond next to any slider to animate it.
              </p>
            ) : (
              animatedProperties(clip).map((path) => (
                <div key={path} className="space-y-1 rounded-md border p-2">
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[10px]">{path}</span>
                    <Button variant="ghost" size="icon" className="ml-auto size-5"
                      title="Remove all keyframes on this property"
                      onClick={() =>
                        keyframesFor(clip, path).forEach((k) =>
                          dispatch({ type: "removeKeyframe", ref: selected, keyframeId: k.id }, true),
                        )
                      }>
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  {keyframesFor(clip, path).map((k) => (
                    <div key={k.id} className="flex items-center gap-1.5 text-[10px]">
                      <Diamond className="size-2.5 fill-primary text-primary" />
                      <span className="tabular-nums">{k.time.toFixed(2)}s</span>
                      <span className="tabular-nums text-muted-foreground">{k.value.toFixed(2)}</span>
                      <Select value={k.easing}
                        onValueChange={(v) => dispatch({ type: "patchKeyframe", ref: selected, keyframeId: k.id, patch: { easing: v as never } })}>
                        <SelectTrigger className="ml-auto h-5 w-[76px] text-[10px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["linear", "ease", "easeIn", "easeOut", "hold"].map((e) => (
                            <SelectItem key={e} value={e}>{e}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="icon" className="size-5"
                        onClick={() => dispatch({ type: "removeKeyframe", ref: selected, keyframeId: k.id })}>
                        <X className="size-2.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function SceneInspector({
  project,
  dispatch,
}: {
  project: Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  return (
    <div className="h-full space-y-4 overflow-y-auto p-2.5">
      <div>
        <h3 className="text-xs font-medium">Sequence</h3>
        <p className="text-[11px] text-muted-foreground">Nothing selected — click a clip to edit it.</p>
      </div>

      <Field label="Frame size">
        <Select
          value={`${project.width}x${project.height}`}
          onValueChange={(v) => {
            const preset = SIZE_PRESETS.find((p) => `${p.width}x${p.height}` === v);
            if (preset) dispatch({ type: "setProject", patch: { width: preset.width, height: preset.height } });
          }}
        >
          <SelectTrigger className="h-7 text-[11px]"><SelectValue placeholder={`${project.width}×${project.height}`} /></SelectTrigger>
          <SelectContent>
            {/* Presets can share dimensions, so the value has to be the size,
                not the label — two items with one value stack in the trigger. */}
            {[...new Map(SIZE_PRESETS.map((p) => [`${p.width}x${p.height}`, p])).values()].map((p) => (
              <SelectItem key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                {p.width}×{p.height} · {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Frame rate">
        <Select value={String(project.frameRate)}
          onValueChange={(v) => dispatch({ type: "setProject", patch: { frameRate: Number(v) } })}>
          <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {/* The project's own rate has to be in the list or the trigger
                renders empty — a sequence built from a sparse recording can
                legitimately sit at a rate no preset offers. */}
            {[...new Set([24, 25, 30, 50, 60, Math.round(project.frameRate)])]
              .filter((f) => f > 0)
              .sort((a, b) => a - b)
              .map((f) => <SelectItem key={f} value={String(f)}>{f} fps</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Background">
        <div className="grid grid-cols-5 gap-1.5">
          {BACKGROUND_PRESETS.map((preset) => (
            <button key={preset.name} title={preset.name}
              onClick={() => dispatch({ type: "setProject", patch: { background: preset.background } })}
              className={cn(
                "h-7 rounded border transition-transform hover:scale-105",
                JSON.stringify(project.background) === JSON.stringify(preset.background) && "ring-2 ring-primary",
              )}
              style={{
                background:
                  preset.background.type === "solid"
                    ? preset.background.color
                    : preset.background.type === "gradient"
                      ? `linear-gradient(${preset.background.angle}deg, ${preset.background.from}, ${preset.background.to})`
                      : "repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 8px 8px",
              }} />
          ))}
        </div>
      </Field>

      <NumberSlider label="Padding" value={project.padding} min={0} max={0.2} step={0.005}
        format={(v) => `${Math.round(v * 200)}%`} defaultValue={0} dispatch={dispatch}
        onChange={(v, c) => dispatch({ type: "setProject", patch: { padding: v } }, c)} />

      <Separator />
      <div className="space-y-1 text-[11px] text-muted-foreground">
        <p>{project.tracks.length} tracks · {project.assets.length} sources</p>
        <p>{project.markers.length} markers · {project.captions.length} captions</p>
      </div>
    </div>
  );
}
