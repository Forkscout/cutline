import { useEffect, useRef, useState } from "react";
import { lockedTracksIn } from "@/editor/cut";
import { toast } from "sonner";
import { MessageSquarePlus, Palette,
  ChevronLeft,
  ChevronRight,
  Grid3x3,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import type { ClipRef, Project } from "@/editor/types";
import type { AssetUrls } from "@/editor/media";
import { PlaybackEngine } from "@/editor/playback";
import { projectDuration } from "@/editor/project";
import { fontsInUse } from "@/editor/themes";
import { loadFonts } from "@/lib/fonts";
import type { Action } from "@/editor/project";
import { MonitorOverlay } from "@/components/editor/monitor-overlay";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { formatTimecode } from "@/lib/format";
import { cn } from "@/lib/utils";

const ZOOM_OPTIONS = ["fit", "0.25", "0.5", "1", "2"] as const;

export function Monitor({
  project,
  urls,
  onEngine,
  onTime,
  onCanvas,
  dispatch,
  selected,
  onSelect,
  noting = false,
  onToggleNoting,
  onCompareLooks,
}: {
  project: Project;
  urls: AssetUrls;
  onEngine: (engine: PlaybackEngine | null) => void;
  onTime: (time: number) => void;
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
  dispatch: (action: Action, coalesce?: boolean) => void;
  selected: ClipRef | null;
  onSelect: (ref: ClipRef | null) => void;
  noting?: boolean;
  onToggleNoting?: (on: boolean) => void;
  onCompareLooks?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The overlay needs the element itself, and a ref is not reactive.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState<(typeof ZOOM_OPTIONS)[number]>("fit");
  const [looping, setLooping] = useState(false);

  /**
   * The callbacks live in refs so the engine's lifetime does not depend on
   * them.
   *
   * A parent that passes inline arrows creates new functions on every render;
   * with those in the dependency list, every edit tore the PlaybackEngine down
   * and built a new one — new `<video>` elements, all at readyState 0 — and the
   * preview went blank until they reloaded. The engine must outlive renders and
   * be replaced only when the canvas or the URL cache changes.
   */
  const callbacks = useRef({ onEngine, onTime, onCanvas });
  callbacks.current = { onEngine, onTime, onCanvas };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new PlaybackEngine(canvas, urls);
    engine.onTick = (t, isPlaying) => {
      setTime(t);
      setPlaying(isPlaying);
      callbacks.current.onTime(t);
    };
    engineRef.current = engine;
    setCanvasEl(canvas);
    callbacks.current.onEngine(engine);
    callbacks.current.onCanvas(canvas);
    return () => {
      engine.dispose();
      engineRef.current = null;
      setCanvasEl(null);
      callbacks.current.onEngine(null);
      callbacks.current.onCanvas(null);
    };
  }, [urls]);

  // Every edit has to reach the engine, and a re-render alone would not repaint
  // a paused canvas — so this both syncs the elements and redraws.
  useEffect(() => {
    void engineRef.current?.setProject(project).then(() => engineRef.current?.render());
  }, [project]);

  // A web font draws on a canvas only once it has loaded; until then the text
  // shows in a fallback, so the frame is drawn again when the faces arrive.
  const fontKey = fontsInUse(project).join("|");
  useEffect(() => {
    let live = true;
    void loadFonts(fontKey.split("|"))
      .catch(() => [])
      .then(() => live && engineRef.current?.render());
    return () => {
      live = false;
    };
  }, [fontKey]);

  const duration = projectDuration(project);
  const guides = project.guides;

  const canvasStyle =
    zoom === "fit"
      ? { maxWidth: "100%", maxHeight: "100%", aspectRatio: `${project.width} / ${project.height}` }
      : { width: project.width * Number(zoom), height: project.height * Number(zoom) };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/70 p-3">
        <canvas ref={canvasRef} className="rounded shadow-2xl" style={canvasStyle} />
        <MonitorOverlay
          project={project}
          time={time}
          canvas={canvasEl}
          selected={selected}
          onSelect={onSelect}
          dispatch={dispatch}
          noting={noting}
          onNoted={() => onToggleNoting?.(false)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-7" title="Go to start (Home)" onClick={() => engineRef.current?.seek(0)}>
          <SkipBack className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="Previous frame (←)" onClick={() => engineRef.current?.step(-1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button size="icon" className="size-7" title="Play / pause (space, K)" onClick={() => engineRef.current?.toggle()}>
          {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="Next frame (→)" onClick={() => engineRef.current?.step(1)}>
          <ChevronRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="Go to end (End)" onClick={() => engineRef.current?.seek(duration)}>
          <SkipForward className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7", looping && "text-primary")}
          title="Loop playback"
          onClick={() => {
            const next = !looping;
            setLooping(next);
            if (engineRef.current) engineRef.current.loop = next;
          }}
        >
          <Repeat className="size-3.5" />
        </Button>

        <span className="ml-1.5 font-mono text-xs tabular-nums">
          {formatTimecode(time, project.frameRate)}
          <span className="text-muted-foreground"> / {formatTimecode(duration, project.frameRate)}</span>
        </span>

        <div className="ml-auto flex items-center gap-1">
          {onToggleNoting && (
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 gap-1 px-2 text-[11px]", noting && "bg-muted text-primary")}
              title="Leave a note: click the picture where it applies"
              onClick={() => onToggleNoting(!noting)}
            >
              <MessageSquarePlus className="size-3.5" />
              Note
            </Button>
          )}
          {onCompareLooks && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px]" title="See this frame in other looks" onClick={onCompareLooks}>
              <Palette className="size-3.5" />
              Looks
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            title="Set in point (I)"
            onClick={() => dispatch({ type: "setProject", patch: { inPoint: time } })}
          >
            In
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            title="Set out point (O)"
            onClick={() => dispatch({ type: "setProject", patch: { outPoint: time } })}
          >
            Out
          </Button>
          {project.inPoint !== null && project.outPoint !== null && project.outPoint - project.inPoint > 0.05 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              title="Remove everything between In and Out on every track, and close the gap"
              onClick={() => {
                const from = project.inPoint!;
                const to = project.outPoint!;
                const locked = lockedTracksIn(project, from);
                if (locked.length) {
                  toast.error(`${locked.map((t) => t.name).join(", ")} ${locked.length > 1 ? "are" : "is"} locked`, {
                    description: "A cut closes the gap on every track; unlock them so the edit stays in sync.",
                  });
                  return;
                }
                dispatch({ type: "cutRange", from, to });
                dispatch({ type: "setProject", patch: { inPoint: null, outPoint: null } }, true);
                toast.success(`Cut ${(to - from).toFixed(2)} s from every track`, { description: "Undo brings it back." });
              }}
            >
              Cut In–Out
            </Button>
          )}
          {(project.inPoint !== null || project.outPoint !== null) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              onClick={() => dispatch({ type: "setProject", patch: { inPoint: null, outPoint: null } })}
            >
              Clear
            </Button>
          )}

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" title="Guides and safe areas">
                <Grid3x3 className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 space-y-2.5" align="end">
              {(
                [
                  ["grid", "Grid"],
                  ["thirds", "Rule of thirds"],
                  ["center", "Centre guides"],
                  ["actionSafe", "Action safe (90%)"],
                  ["titleSafe", "Title safe (80%)"],
                  ["snapToGuides", "Snap to guides"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">{label}</Label>
                  <Switch
                    className="ml-auto"
                    checked={guides[key]}
                    onCheckedChange={(v) => dispatch({ type: "setGuides", patch: { [key]: v } })}
                  />
                </div>
              ))}
            </PopoverContent>
          </Popover>

          <Select value={zoom} onValueChange={(v) => setZoom(v as typeof zoom)}>
            <SelectTrigger className="h-7 w-[74px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fit">Fit</SelectItem>
              <SelectItem value="0.25">25%</SelectItem>
              <SelectItem value="0.5">50%</SelectItem>
              <SelectItem value="1">100%</SelectItem>
              <SelectItem value="2">200%</SelectItem>
            </SelectContent>
          </Select>

          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Volume2 className="size-3" />
            {project.width}×{project.height}
          </span>
        </div>
      </div>
    </div>
  );
}
