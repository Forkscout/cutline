import { useMemo, useRef, useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { exportProject, type ExportOptions, type ExportProgress } from "@/editor/export";
import { projectDuration } from "@/editor/project";
import { EXPORT_PRESETS, type Container } from "@/editor/presets";
import type { Project } from "@/editor/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const STAGE_LABEL: Record<ExportProgress["stage"], string> = {
  audio: "Mixing audio",
  video: "Encoding frames",
  finalising: "Writing the file",
};

/**
 * Both option lists are built rather than hardcoded, because the project's own
 * height and frame rate have to appear without colliding with a preset. Two
 * `SelectItem`s sharing a value is not cosmetic — Radix keys on the value, so
 * the trigger renders both labels on top of each other.
 */
function heightOptions(project: Project) {
  const seen = new Set<number>();
  const out: { value: string; label: string }[] = [];
  for (const h of [480, 720, 1080, 1440, 2160, project.height]) {
    const rounded = Math.round(h);
    if (rounded <= 0 || seen.has(rounded)) continue;
    seen.add(rounded);
    out.push({ value: String(rounded), label: rounded === project.height ? `Source (${rounded}p)` : `${rounded}p` });
  }
  return out.sort((a, b) => Number(a.value) - Number(b.value));
}

function fpsOptions(project: Project) {
  const source = Math.round(project.frameRate);
  const seen = new Set<number>();
  const out: { value: string; label: string }[] = [];
  for (const f of [24, 25, 30, 50, 60, source]) {
    if (f <= 0 || seen.has(f)) continue;
    seen.add(f);
    out.push({ value: String(f), label: f === source ? `${f} fps (source)` : `${f} fps` });
  }
  return out.sort((a, b) => Number(a.value) - Number(b.value));
}

/**
 * A source rate below 24 is almost always a measurement of a sparse recording
 * rather than an intent, and exporting at it would produce a slideshow. The
 * source rate stays in the list; it is just not the default.
 */
function defaultFps(project: Project): number {
  const source = Math.round(project.frameRate);
  return source >= 24 && source <= 60 ? source : 30;
}

export function ExportDialog({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [presetId, setPresetId] = useState("custom");
  const [container, setContainer] = useState<Container>("mp4");
  const [height, setHeight] = useState(String(Math.min(1080, project.height) || 1080));
  const [fps, setFps] = useState(String(defaultFps(project)));
  const [quality, setQuality] = useState<ExportOptions["quality"]>("high");
  const [bitrate, setBitrate] = useState("");
  const [useInOut, setUseInOut] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<Blob | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const duration = projectDuration(project);
  const hasRange = project.inPoint !== null || project.outPoint !== null;
  const running = progress !== null && result === null;
  const heights = useMemo(() => heightOptions(project), [project]);
  const rates = useMemo(() => fpsOptions(project), [project]);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = EXPORT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setContainer(preset.container);
    setHeight(String(preset.height));
    setFps(String(preset.frameRate));
    setQuality(preset.quality);
    setBitrate(preset.bitrateMbps ? String(preset.bitrateMbps) : "");
  };

  const run = async () => {
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ stage: "audio", progress: 0, frame: 0, totalFrames: 0 });
    const startedAt = performance.now();

    try {
      const blob = await exportProject(
        project,
        {
          container,
          height: Number(height),
          frameRate: Number(fps),
          quality,
          bitrateMbps: bitrate ? Number(bitrate) : null,
          useInOut,
        },
        setProgress,
        controller.signal,
      );
      setResult(blob);
      const seconds = (performance.now() - startedAt) / 1000;
      toast.success(
        `Exported ${formatBytes(blob.size)} in ${formatDuration(seconds * 1000)} — ${(duration / seconds).toFixed(1)}× realtime`,
      );
    } catch (err) {
      setProgress(null);
      if (err instanceof DOMException && err.name === "AbortError") toast("Export cancelled.");
      else toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      abortRef.current = null;
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(result);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.name.replace(/[^\w.-]+/g, "-")}.${container}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-encode would orphan the encoder and leave a half file.
        if (!next && running) return;
        setOpen(next);
        if (!next) {
          setProgress(null);
          setResult(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="h-7" disabled={duration <= 0}>
          <Download className="size-3.5" />
          Export
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription>
            Encoded on this machine with WebCodecs. Nothing is uploaded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-1.5">
            {EXPORT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                disabled={running}
                onClick={() => applyPreset(preset.id)}
                className={cn(
                  "rounded-md border p-2 text-left transition-colors hover:border-primary/60 disabled:opacity-50",
                  presetId === preset.id && "border-primary bg-primary/10",
                )}
              >
                <p className="truncate text-[11px] font-medium">{preset.label}</p>
                <p className="truncate text-[10px] text-muted-foreground">{preset.note}</p>
              </button>
            ))}
          </div>

          <Separator />

          <div className="grid grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Format</Label>
              <Select value={container} onValueChange={(v) => { setContainer(v as Container); setPresetId("custom"); }} disabled={running}>
                <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mp4">MP4 · H.264</SelectItem>
                  <SelectItem value="webm">WebM · VP9</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Resolution</Label>
              <Select value={height} onValueChange={(v) => { setHeight(v); setPresetId("custom"); }} disabled={running}>
                <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {heights.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Frame rate</Label>
              <Select value={fps} onValueChange={(v) => { setFps(v); setPresetId("custom"); }} disabled={running}>
                <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {rates.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Quality</Label>
              <Select value={quality} onValueChange={(v) => { setQuality(v as ExportOptions["quality"]); setPresetId("custom"); }} disabled={running}>
                <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="veryHigh">Very high</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-end gap-4">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Bitrate (Mbps)</Label>
              <Input value={bitrate} placeholder="Auto" disabled={running} className="h-8 w-28 text-xs"
                onChange={(e) => { setBitrate(e.target.value.replace(/[^\d.]/g, "")); setPresetId("custom"); }} />
            </div>
            {hasRange && (
              <div className="flex items-center gap-2 pb-2">
                <Label className="text-[11px] text-muted-foreground">In / out range only</Label>
                <Switch checked={useInOut} onCheckedChange={setUseInOut} disabled={running} />
              </div>
            )}
            <p className="ml-auto pb-2 text-[11px] text-muted-foreground">
              {formatDuration(duration * 1000)} · {project.width}×{project.height}
            </p>
          </div>

          {progress && (
            <div className="space-y-2">
              <Progress value={progress.progress * 100} />
              <p className="text-xs text-muted-foreground">
                {result ? (
                  <span className="flex items-center gap-1.5 text-emerald-400">
                    <Check className="size-3.5" />
                    Done — {formatBytes(result.size)}
                  </span>
                ) : (
                  <>
                    {STAGE_LABEL[progress.stage]}
                    {progress.totalFrames > 0 && progress.stage === "video" &&
                      ` — frame ${progress.frame} of ${progress.totalFrames}`}
                  </>
                )}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {running ? (
            <Button variant="secondary" onClick={() => abortRef.current?.abort()}>Cancel</Button>
          ) : result ? (
            <Button onClick={download}>
              <Download className="size-3.5" />
              Save file
            </Button>
          ) : (
            <Button onClick={() => void run()}>
              {progress ? <Loader2 className="size-4 animate-spin" /> : null}
              Start export
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
