import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { parseSubtitles, toSrt, toVtt } from "@/editor/captions";
import type { Action } from "@/editor/project";
import { captionsFromWords, wordsOnTimeline } from "@/editor/transcript";
import type { MediaAsset, Project } from "@/editor/types";
import { capabilities, saveProvider, transcribe, type Capabilities, type ProviderReport } from "@/lib/ai";
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

const WHISPER_SERVER =
  "whisper-server -m ~/.cache/whisper-cpp/ggml-medium.bin --inference-path /v1/audio/transcriptions --convert -l auto --port 8178";

/**
 * Connecting a transcription service, in the place it is first needed —
 * never a settings page to visit before recording. Any OpenAI-compatible
 * /audio/transcriptions endpoint: a whisper.cpp server on this machine, or a
 * hosted one with a key.
 */
function ConnectTranscription({ onConnected }: { onConnected: () => void }) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8178/v1");
  const [model, setModel] = useState("whisper-1");
  const [apiKey, setApiKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<ProviderReport | null>(null);

  const connect = async () => {
    setChecking(true);
    try {
      const host = new URL(baseUrl).host.replace(/[^A-Za-z0-9_-]+/g, "-");
      const result = await saveProvider(`transcribe-${host}`, {
        name: new URL(baseUrl).host,
        baseUrl,
        transcribeModel: model,
        ...(apiKey ? { apiKey } : {}),
      });
      setReport(result);
      if (result.capabilities?.transcribe) {
        toast.success(`Connected: ${result.name} can transcribe`);
        onConnected();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not connect.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-muted-foreground">
        Auto-captions needs a speech-to-text service with an OpenAI-compatible API.
      </p>
      <Input className="h-6 text-[10px]" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL" />
      <div className="grid grid-cols-2 gap-1">
        <Input className="h-6 text-[10px]" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model" />
        <Input className="h-6 text-[10px]" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder="API key (optional)" />
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        A key stays in ~/Cutline on this machine and is sent only to this URL.
      </p>
      <Button size="sm" className="h-6 w-full text-[10px]" disabled={checking || !baseUrl} onClick={() => void connect()}>
        {checking ? "Checking…" : "Connect"}
      </Button>
      {report && !report.capabilities?.transcribe && (
        <div className="space-y-1 rounded-md border border-destructive/40 p-1.5 text-[10px] leading-snug">
          <p>
            {report.capabilities?.reachable ? "Reachable, but it cannot transcribe." : "Could not reach it."}{" "}
            {report.capabilities?.message}
          </p>
          <p className="text-muted-foreground">
            LM Studio has no transcription endpoint yet. A whisper.cpp server on this machine does:
          </p>
          <code className="block break-all rounded bg-muted p-1 font-mono text-[9px]">{WHISPER_SERVER}</code>
        </div>
      )}
    </div>
  );
}

function AutoCaptions({
  project,
  dispatch,
}: {
  project: Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [editing, setEditing] = useState(false);
  const [language, setLanguage] = useState<string>("auto");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    capabilities()
      .then(setCaps)
      .catch(() => setCaps({ transcribe: null }));
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
    setBusy("Starting…");
    try {
      const target =
        asset.origin.type === "recording"
          ? { sessionId: asset.origin.sessionId, fileName: asset.origin.fileName }
          : { mediaId: asset.id };
      const transcript = await transcribe(
        target,
        { ...(language !== "auto" ? { language } : {}), force },
        (fraction, note) => setBusy(`${note} · ${Math.round(fraction * 100)}%`),
      );
      // Only this asset's words, placed through its clips on the timeline.
      const clipIds = new Set(project.tracks.flatMap((t) => t.clips.filter((c) => c.assetId === asset.id).map((c) => c.id)));
      const withTranscript: Project = {
        ...project,
        assets: project.assets.map((a) => (a.id === asset.id ? { ...a, transcript } : a)),
      };
      const words = wordsOnTimeline(withTranscript).filter((w) => clipIds.has(w.clipId));
      const cues = captionsFromWords(words).map((cue) => ({ id: crypto.randomUUID(), ...cue }));
      dispatch({ type: "patchAsset", assetId: asset.id, patch: { transcript } });
      // Coalesced: the transcript and the captions are one undo step.
      dispatch({ type: "setCaptions", cues }, true);
      toast.success(`${cues.length} captions from ${transcript.words.length} words`, {
        description: transcript.timing === "segment" ? "The service gave sentence times only, so word timing is estimated." : undefined,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      setBusy(null);
    }
  };

  if (caps === null) return null;

  if (!caps.transcribe || editing) {
    return (
      <ConnectTranscription
        onConnected={() => {
          setEditing(false);
          void refresh();
        }}
      />
    );
  }

  if (sources.length === 0) {
    return <p className="text-[10px] text-muted-foreground">Put a clip with sound on the timeline to caption it.</p>;
  }

  return (
    <div className="space-y-1.5">
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
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className={cn("rounded-full px-1.5 py-0.5", caps.transcribe.local ? "bg-primary/15 text-foreground" : "bg-muted")}>
          {caps.transcribe.local ? "on this machine" : `sent to ${caps.transcribe.name}`}
        </span>
        <span className="truncate">{caps.transcribe.model}</span>
        <button className="ml-auto underline-offset-2 hover:underline" onClick={() => setEditing(true)}>change</button>
      </div>
    </div>
  );
}

export function CaptionsPanel({
  project,
  time,
  dispatch,
  onSeek,
}: {
  project: Project;
  time: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onSeek: (time: number) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const style = project.captionStyle;

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
        <AutoCaptions project={project} dispatch={dispatch} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {project.captions.length === 0 ? (
          <p className="p-2 text-[11px] text-muted-foreground">
            No captions. Generate them, import an SRT or VTT file, or add cues by hand.
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

      <div className="space-y-2.5 border-t p-2">
        <Label className="text-[11px] font-medium">Style</Label>
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
    </div>
  );
}
