import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Download, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { parseSubtitles, toSrt, toVtt } from "@/editor/captions";
import type { Action } from "@/editor/project";
import type { MediaAsset, Project } from "@/editor/types";
import {
  capabilities,
  listProviders,
  type Capabilities,
  type ProviderReport,
} from "@/lib/ai";
import type { AutoCaptionOptions } from "@/components/editor/auto-captions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ColorField, Field, NumberSlider } from "@/components/editor/controls";
import { formatTimecode } from "@/lib/format";
import { cn } from "@/lib/utils";

function download(text: string, name: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const LANGUAGES = [
  ["auto", "Detect"],
  ["en", "English"],
  ["hi", "Hindi"],
] as const;

const providerLabel2 = (name: string) => name;

function AutoCaptions({
  project,
  dispatch,
  onAutoCaption,
  onOpenServices,
}: {
  project: Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onAutoCaption: (assetId: string, options?: AutoCaptionOptions) => Promise<boolean>;
  /** Opens the Services dialog: connecting and choosing happen in one place. */
  onOpenServices: () => void;
}) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [providers, setProviders] = useState<ProviderReport[]>([]);
  const [language, setLanguage] = useState<string>("auto");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      capabilities().then(setCaps).catch(() => setCaps({ transcribe: null })),
      listProviders().then(setProviders).catch(() => setProviders([])),
    ]);

  useEffect(() => {
    void refresh();
  }, []);

  // Audio that is actually on the timeline; the microphone first, since it is
  // the voice and was recorded as its own file for exactly this.
  const sources = useMemo(() => {
    const used = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.assetId)));
    return project.assets
      .filter((a) => a.hasAudio && used.has(a.id))
      .sort((a, b) => Number(b.sourceKind === "microphone") - Number(a.sourceKind === "microphone"));
  }, [project.assets, project.tracks]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source = sources.find((a) => a.id === sourceId) ?? sources[0];

  const generate = async (asset: MediaAsset, force: boolean) => {
    setBusy("Transcribing…");
    try {
      await onAutoCaption(asset.id, { force, ...(language !== "auto" ? { language } : {}) });
    } finally {
      setBusy(null);
    }
  };

  if (caps === null) return null;

  // The project's own service when it named one, and the workspace's otherwise.
  const own = project.services.transcribe ? providers.find((p) => p.id === project.services.transcribe && p.capabilities?.transcribe) : undefined;
  const active = own ? { name: own.name, model: own.transcribeModel, local: own.local } : caps.transcribe;

  if (!active) {
    return (
      <div className="space-y-1.5 rounded-md border p-2">
        <p className="text-[10px] leading-snug text-muted-foreground">
          Captions need a speech-to-text service: a whisper.cpp server on this machine, or OpenAI, Groq, OpenRouter or ElevenLabs with a key.
        </p>
        <Button size="sm" className="h-6 w-full text-[10px]" onClick={onOpenServices}>
          Set one up
        </Button>
      </div>
    );
  }
  const usable = providers.filter((p) => p.capabilities?.transcribe);
  const service = (
    <div className="space-y-1 rounded-md border p-1.5">
      <div className="flex items-center gap-1 text-[10px]">
        <span className="size-1.5 rounded-full bg-primary" />
        <span className="font-medium">Speech-to-text</span>
        <span className={cn("ml-auto rounded-full px-1.5 py-0.5", active.local ? "bg-primary/15 text-foreground" : "bg-muted")}>
          {active.local ? "on this machine" : "hosted"}
        </span>
      </div>
      <select
        className="h-6 w-full rounded-md border bg-background px-1 text-[10px]"
        value={project.services.transcribe ?? ""}
        disabled={busy !== null}
        onChange={(e) => dispatch({ type: "setServices", patch: { transcribe: e.target.value || undefined } })}
      >
        <option value="">Workspace default{caps.transcribe ? ` — ${providerLabel2(caps.transcribe.name)}` : " — none"}</option>
        {usable.map((p) => (
          <option key={p.id} value={p.id}>
            {providerLabel(p)} · {p.transcribeModel}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className="truncate">{active.local ? "Nothing leaves this machine." : `Audio is sent to ${active.name}.`}</span>
        <button className="ml-auto shrink-0 underline-offset-2 hover:underline" onClick={onOpenServices}>
          Manage
        </button>
      </div>
    </div>
  );

  if (sources.length === 0) {
    return (
      <div className="space-y-1.5">
        {service}
        <p className="text-[10px] text-muted-foreground">Put a clip with sound on the timeline to caption it.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {service}
      <div className="grid grid-cols-2 gap-1">
        <select className="h-6 rounded-md border bg-background px-1 text-[10px]" value={source?.id}
          onChange={(e) => setSourceId(e.target.value)} disabled={busy !== null}>
          {sources.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select className="h-6 rounded-md border bg-background px-1 text-[10px]" value={language}
          onChange={(e) => setLanguage(e.target.value)} disabled={busy !== null}>
          {LANGUAGES.map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
      </div>
      <Button size="sm" className="h-7 w-full text-[11px]" disabled={busy !== null || !source}
        onClick={() => source && void generate(source, Boolean(source.transcript))}>
        <Sparkles className="size-3.5" />
        {busy ?? (source?.transcript ? "Transcribe again" : "Generate captions")}
      </Button>
    </div>
  );
}

/** A connected service as people know it: "whisper.cpp · this Mac", not "127.0.0.1:8178". */
function providerLabel(p: ProviderReport): string {
  if (p.capabilities?.flavor === "whisper.cpp") return p.local ? "whisper.cpp · this Mac" : "whisper.cpp";
  return p.name;
}

export function CaptionsPanel({
  project,
  time,
  dispatch,
  onSeek,
  onAutoCaption,
 onOpenServices,}: {
  project: Project;
  time: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onSeek: (time: number) => void;
  onAutoCaption: (assetId: string, options?: AutoCaptionOptions) => Promise<boolean>;
  /** Opens the Services dialog, where a service is connected and chosen. */
  onOpenServices: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const style = project.captionStyle;
  const [styleOpen, setStyleOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="text-xs font-medium">Captions</span>
        <Switch
          className="ml-2 scale-75"
          checked={project.captionsEnabled}
          onCheckedChange={(v) => dispatch({ type: "setProject", patch: { captionsEnabled: v } })}
        />
        <Button variant="ghost" size="icon" className="ml-auto size-6" title="Import SRT or VTT"
          onClick={() => fileInput.current?.click()}>
          <Upload className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" title="Export SRT"
          disabled={project.captions.length === 0}
          onClick={() => download(toSrt(project.captions), `${project.name}.srt`, "text/plain")}>
          <Download className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" title="Add a cue at the playhead"
          onClick={() =>
            dispatch({
              type: "addCaption",
              cue: { id: crypto.randomUUID(), start: time, end: time + 2, text: "New caption" },
            })
          }>
          <Plus className="size-3.5" />
        </Button>
        <input ref={fileInput} type="file" accept=".srt,.vtt,text/plain" className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const cues = parseSubtitles(await file.text());
            if (cues.length === 0) {
              toast.error("No cues found in that file.");
              return;
            }
            dispatch({ type: "setCaptions", cues });
            toast.success(`Imported ${cues.length} cues`);
          }} />
      </div>

      <div className="border-b p-2">
        <Label className="mb-1.5 flex items-center gap-1 text-[11px] font-medium">
          <Sparkles className="size-3" /> Auto-captions
        </Label>
        <AutoCaptions project={project} dispatch={dispatch} onAutoCaption={onAutoCaption} onOpenServices={onOpenServices} />
      </div>

      <div className="min-h-24 flex-1 overflow-y-auto p-2">
        {project.captions.length === 0 ? (
          <p className="p-2 text-[11px] text-muted-foreground">
            No captions. Right-click a clip with sound and choose Generate captions, import an SRT or VTT file, or add cues by hand.
          </p>
        ) : (
          <div className="space-y-1.5">
            {project.captions.map((cue) => {
              const active = time >= cue.start && time < cue.end;
              return (
                <div key={cue.id}
                  className={cn("space-y-1 rounded-md border p-1.5", active && "border-primary bg-muted")}>
                  <div className="flex items-center gap-1">
                    <button className="font-mono text-[10px] tabular-nums text-primary hover:underline"
                      onClick={() => onSeek(cue.start)}>
                      {formatTimecode(cue.start, project.frameRate)}
                    </button>
                    <span className="text-[10px] text-muted-foreground">→</span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {formatTimecode(cue.end, project.frameRate)}
                    </span>
                    <Button variant="ghost" size="icon" className="ml-auto size-5"
                      onClick={() => dispatch({ type: "deleteCaption", cueId: cue.id })}>
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  <Textarea value={cue.text} rows={2} className="min-h-0 text-[11px]"
                    onChange={(e) => dispatch({ type: "patchCaption", cueId: cue.id, patch: { text: e.target.value } })} />
                  <div className="grid grid-cols-2 gap-1">
                    <Input type="number" step={0.1} className="h-6 text-[10px]" value={cue.start.toFixed(2)}
                      onChange={(e) => dispatch({ type: "patchCaption", cueId: cue.id, patch: { start: Number(e.target.value) } })} />
                    <Input type="number" step={0.1} className="h-6 text-[10px]" value={cue.end.toFixed(2)}
                      onChange={(e) => dispatch({ type: "patchCaption", cueId: cue.id, patch: { end: Number(e.target.value) } })} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Folded by default: open, it is taller than most panels and left the
          cue list with no height at all — generated captions looked missing. */}
      <div className={cn("shrink-0 border-t", styleOpen && "max-h-[55%] overflow-y-auto")}>
        <button
          className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-medium hover:bg-muted/50"
          aria-expanded={styleOpen}
          onClick={() => setStyleOpen((open) => !open)}
        >
          <ChevronRight className={cn("size-3 transition-transform", styleOpen && "rotate-90")} />
          Style
        </button>
        {styleOpen && (
        <div className="space-y-2.5 px-2 pb-2">
        <NumberSlider label="Size" value={style.fontSize} min={16} max={120} step={1}
          format={(v) => `${Math.round(v)}px`} dispatch={dispatch}
          onChange={(v, c) => dispatch({ type: "setCaptionStyle", patch: { fontSize: v } }, c)} />
        <NumberSlider label="Vertical position" value={style.y} min={0.05} max={0.95} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`} dispatch={dispatch}
          onChange={(v, c) => dispatch({ type: "setCaptionStyle", patch: { y: v } }, c)} />
        <ColorField label="Colour" value={style.color}
          onChange={(v) => dispatch({ type: "setCaptionStyle", patch: { color: v } })} />
        <NumberSlider label="Outline" value={style.strokeWidth} min={0} max={12} step={0.5} dispatch={dispatch}
          onChange={(v, c) => dispatch({ type: "setCaptionStyle", patch: { strokeWidth: v } }, c)} />
        <Field label="Backing">
          <div className="grid grid-cols-3 gap-1">
            {([["None", null], ["Dark", "rgba(0,0,0,0.65)"], ["Light", "rgba(255,255,255,0.8)"]] as const).map(
              ([label, value]) => (
                <Button key={label} size="sm" className="h-6 text-[10px]"
                  variant={style.background === value ? "secondary" : "ghost"}
                  onClick={() => dispatch({ type: "setCaptionStyle", patch: { background: value } })}>
                  {label}
                </Button>
              ),
            )}
          </div>
        </Field>
        <Separator />
        <Button variant="ghost" size="sm" className="h-6 w-full text-[10px]"
          disabled={project.captions.length === 0}
          onClick={() => download(toVtt(project.captions), `${project.name}.vtt`, "text/vtt")}>
          Export WebVTT
        </Button>
        </div>
        )}
      </div>
    </div>
  );
}
