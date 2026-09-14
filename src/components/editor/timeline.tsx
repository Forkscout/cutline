import { useCallback, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  EllipsisVertical,
  Link2,
  Link2Off,
  Eye,
  EyeOff,
  Headphones,
  Lock,
  Magnet,
  MapPin,
  Music,
  Plus,
  Scissors,
  Trash2,
  Unlock,
  Video,
  Volume2,
  VolumeX,
  Sparkles,
  Captions,
} from "lucide-react";
import type { Action } from "@/editor/project";
import type { AutoCaptionOptions } from "@/components/editor/auto-captions";
import { ROW_DENSITIES, assetOf, linkSize, rowHeight, snapPoints, type RowDensity } from "@/editor/project";
import type { Clip, ClipRef, Marker, Project, Track } from "@/editor/types";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

const HEADER_WIDTH = 150;
const RULER_HEIGHT = 28;
/** The captions lane under the ruler, there once the project has captions. */
const CAPTION_LANE_HEIGHT = 22;
/** Snap when within this many pixels — a distance, not a duration, so it feels
 *  the same at every zoom level. */
const SNAP_PX = 8;

export type Tool = "select" | "razor" | "slip";

const CLIP_STYLE: Record<string, string> = {
  screen: "bg-sky-500/25 border-sky-400/50",
  camera: "bg-emerald-500/25 border-emerald-400/50",
  microphone: "bg-amber-500/25 border-amber-400/50",
  "system-audio": "bg-violet-500/25 border-violet-400/50",
  video: "bg-indigo-500/25 border-indigo-400/50",
  audio: "bg-teal-500/25 border-teal-400/50",
  image: "bg-fuchsia-500/25 border-fuchsia-400/50",
  text: "bg-rose-500/25 border-rose-400/50",
  shape: "bg-orange-500/25 border-orange-400/50",
};

function clipStyle(project: Project, clip: Clip): string {
  if (clip.kind === "text") return CLIP_STYLE.text!;
  if (clip.kind === "shape") return CLIP_STYLE.shape!;
  const asset = assetOf(project, clip);
  if (!asset) return CLIP_STYLE.video!;
  return CLIP_STYLE[asset.sourceKind ?? asset.kind] ?? CLIP_STYLE.video!;
}

/** Tick spacing that stays legible: never closer than ~56px apart. */
function tickStep(pxPerSec: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) {
    if (step * pxPerSec >= 56) return step;
  }
  return 600;
}

function Waveform({ clip, peaks, width, height }: { clip: Clip; peaks: number[]; width: number; height: number }) {
  // One path for the whole waveform rather than a rect per bucket: a two-minute
  // clip at 40 buckets a second is 4,800 rects, and the browser will happily
  // spend a frame laying them out.
  const path = useMemo(() => {
    if (width < 4 || peaks.length < 2) return "";
    const buckets = peaks.length / 2;
    const perSecond = buckets / Math.max(0.001, clip.duration / clip.speed);
    const startBucket = Math.floor(clip.inPoint * perSecond);
    const visibleBuckets = Math.max(1, Math.floor(clip.duration * clip.speed * perSecond));
    const stepPx = width / visibleBuckets;
    const mid = height / 2;
    let d = "";
    // Never draw more segments than there are pixels to show them.
    const stride = Math.max(1, Math.ceil(visibleBuckets / width));
    for (let i = 0; i < visibleBuckets; i += stride) {
      const index = (startBucket + i) * 2;
      const min = peaks[index] ?? 0;
      const max = peaks[index + 1] ?? 0;
      const x = i * stepPx;
      d += `M${x.toFixed(1)},${(mid + min * mid).toFixed(1)}L${x.toFixed(1)},${(mid + max * mid).toFixed(1)}`;
    }
    return d;
  }, [clip.inPoint, clip.duration, clip.speed, peaks, width, height]);

  if (!path) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" preserveAspectRatio="none">
      <path d={path} stroke="currentColor" strokeWidth="1" opacity="0.55" fill="none" />
    </svg>
  );
}

export function Timeline({
  project,
  time,
  selected,
  tool,
  onTool,
  onSelect,
  onSeek,
  dispatch,
  onDropAsset,
  onAutoCaption,
  onOpenCaptions,
}: {
  project: Project;
  time: number;
  selected: ClipRef | null;
  tool: Tool;
  onTool: (tool: Tool) => void;
  onSelect: (ref: ClipRef | null) => void;
  onSeek: (time: number) => void;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onDropAsset: (assetId: string, trackId: string, start: number) => void;
  /** Transcribes the clip's source and captions where it is heard. */
  onAutoCaption?: (assetId: string, options?: AutoCaptionOptions) => void;
  /** Double-clicking a caption opens the Captions panel to edit it. */
  onOpenCaptions?: () => void;
}) {
  const [pxPerSec, setPxPerSec] = useState(70);
  const captionLane = project.captions.length > 0 ? CAPTION_LANE_HEIGHT : 0;
  const [snapping, setSnapping] = useState(true);
  const lanesRef = useRef<HTMLDivElement>(null);

  const duration = Math.max(
    ...project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)),
    10,
  );
  const contentWidth = Math.max(duration * pxPerSec + 240, 600);

  const snap = useCallback(
    (value: number, excludeClipId?: string) => {
      if (!snapping) return value;
      const tolerance = SNAP_PX / pxPerSec;
      const points = [...snapPoints(project, excludeClipId), time];
      let best = value;
      let bestDelta = tolerance;
      for (const point of points) {
        const delta = Math.abs(point - value);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = point;
        }
      }
      return best;
    },
    [project, time, pxPerSec, snapping],
  );

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const lanes = lanesRef.current;
      if (!lanes) return 0;
      const rect = lanes.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left + lanes.scrollLeft) / pxPerSec);
    },
    [pxPerSec],
  );

  // How tall rows are is the viewer's choice, kept in this browser: a view, not an edit to the project.
  const [density, setDensity] = useState<RowDensity>(() => {
    try {
      const saved = localStorage.getItem("cutline:rows");
      return saved && saved in ROW_DENSITIES ? (saved as RowDensity) : "normal";
    } catch {
      return "normal";
    }
  });
  const chooseDensity = (next: RowDensity) => {
    setDensity(next);
    try {
      localStorage.setItem("cutline:rows", next);
    } catch {
      // A private window: the choice lasts as long as the page.
    }
  };
  const heights = useMemo(() => new Map(project.tracks.map((t) => [t.id, rowHeight(project, t, density)])), [project, density]);
  const heightOf = useCallback((track: Track) => heights.get(track.id) ?? ROW_DENSITIES[density].other, [heights, density]);

  const trackAtClientY = useCallback(
    (clientY: number): Track | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      const rect = lanes.getBoundingClientRect();
      let offset = rect.top + RULER_HEIGHT + captionLane - lanes.scrollTop;
      for (const track of project.tracks) {
        if (clientY >= offset && clientY < offset + heightOf(track)) return track;
        offset += heightOf(track);
      }
      return null;
    },
    [project.tracks, captionLane, heightOf],
  );

  const scrub = (event: React.PointerEvent) => {
    onSeek(timeAtClientX(event.clientX));
    const move = (ev: PointerEvent) => onSeek(timeAtClientX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const beginDrag = (
    event: React.PointerEvent,
    mode: "move" | "in" | "out",
    ref: ClipRef,
    clip: Clip,
  ) => {
    // Only the primary button drags. Without this a right-click starts a drag
    // and swallows the event the context menu needs.
    if (event.button !== 0) return;
    const track = project.tracks.find((t) => t.id === ref.trackId);
    if (track?.locked) return;
    event.stopPropagation();
    onSelect(ref);

    if (tool === "razor" && mode === "move") {
      dispatch({ type: "splitClip", ref, time: timeAtClientX(event.clientX) });
      return;
    }

    const startX = event.clientX;
    const origin = { start: clip.start, duration: clip.duration, inPoint: clip.inPoint };
    // The first move of a drag opens a history entry; the rest fold into it, so
    // one drag costs one undo rather than fifty.
    let first = true;

    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) / pxPerSec;
      const free = ev.shiftKey;
      const ripple = ev.altKey;

      if (mode === "move") {
        if (tool === "slip") {
          dispatch({ type: "slipClip", ref, delta: origin.inPoint + delta - clip.inPoint }, !first);
        } else {
          const raw = Math.max(0, origin.start + delta);
          const target = trackAtClientY(ev.clientY);
          dispatch(
            {
              type: "moveClip",
              ref,
              start: free ? raw : snap(raw, clip.id),
              ...(target && target.id !== ref.trackId ? { toTrackId: target.id } : {}),
            },
            !first,
          );
        }
      } else if (mode === "in") {
        const raw = origin.start + delta;
        dispatch(
          { type: "trimClip", ref, edge: "in", time: free ? raw : snap(raw, clip.id), ripple },
          !first,
        );
      } else {
        const raw = origin.start + origin.duration + delta;
        dispatch(
          { type: "trimClip", ref, edge: "out", time: free ? raw : snap(raw, clip.id), ripple },
          !first,
        );
      }
      first = false;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const step = tickStep(pxPerSec);
  const ticks = Math.ceil(contentWidth / pxPerSec / step) + 1;
  const totalHeight = project.tracks.reduce((n, t) => n + heightOf(t), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        {(
          [
            ["select", "Select (V)", Video],
            ["razor", "Razor (C)", Scissors],
            ["slip", "Slip (Y)", Copy],
          ] as const
        ).map(([id, label, Icon]) => (
          <Button
            key={id}
            variant={tool === id ? "secondary" : "ghost"}
            size="icon"
            className="size-7"
            title={label}
            onClick={() => onTool(id)}
          >
            <Icon className="size-3.5" />
          </Button>
        ))}

        <div className="mx-1 h-4 w-px bg-border" />

        <Button
          variant={snapping ? "secondary" : "ghost"}
          size="icon"
          className="size-7"
          title="Snapping (N)"
          onClick={() => setSnapping(!snapping)}
        >
          <Magnet className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Add marker (M)"
          onClick={() =>
            dispatch({
              type: "addMarker",
              marker: {
                id: crypto.randomUUID(),
                time,
                duration: 0,
                name: `Marker ${project.markers.length + 1}`,
                note: "",
                color: "#f59e0b",
              },
            })
          }
        >
          <MapPin className="size-3.5" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" title="How tall the rows are">
              Rows
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="text-xs">
            {(Object.keys(ROW_DENSITIES) as RowDensity[]).map((name) => (
              <DropdownMenuItem key={name} onClick={() => chooseDensity(name)}>
                <span className="w-3">{density === name ? "✓" : ""}</span>
                {name[0]!.toUpperCase() + name.slice(1)}
                <span className="ml-auto pl-3 text-[10px] text-muted-foreground tabular-nums">
                  {ROW_DENSITIES[name].main} / {ROW_DENSITIES[name].other}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => dispatch({ type: "addTrack", kind: "video" })}
        >
          <Plus className="size-3" />
          Video
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => dispatch({ type: "addTrack", kind: "audio" })}
        >
          <Plus className="size-3" />
          Audio
        </Button>

        <span className="ml-2 hidden text-[11px] text-muted-foreground xl:inline">
          Drag to move · edges to trim · Alt ripples · Shift ignores snapping
        </span>

        <div className="ml-auto flex w-36 items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Zoom</span>
          <Slider
            value={[pxPerSec]}
            min={6}
            max={400}
            step={1}
            onValueChange={([v]) => setPxPerSec(v ?? 70)}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="shrink-0 overflow-hidden border-r" style={{ width: HEADER_WIDTH }}>
          <div style={{ height: RULER_HEIGHT }} className="border-b bg-muted/30" />
          {captionLane > 0 && (
            <div
              style={{ height: captionLane }}
              className={cn(
                "flex items-center gap-1 border-b px-1.5 text-[11px] font-medium",
                !project.captionsEnabled && "text-muted-foreground",
              )}
            >
              <Captions className="size-3 shrink-0 text-muted-foreground" />
              Captions
              {!project.captionsEnabled && <span className="text-[10px] font-normal">· off</span>}
            </div>
          )}
          {project.tracks.map((track, index) => (
            <TrackHeader
              key={track.id}
              track={track}
              index={index}
              total={project.tracks.length}
              height={heightOf(track)}
              dispatch={dispatch}
            />
          ))}
        </div>

        <div ref={lanesRef} className="relative min-w-0 flex-1 overflow-auto">
          <div style={{ width: contentWidth, minHeight: totalHeight + RULER_HEIGHT + captionLane }}>
            <div
              className="sticky top-0 z-20 cursor-ew-resize border-b bg-muted/60 backdrop-blur select-none"
              style={{ height: RULER_HEIGHT }}
              onPointerDown={scrub}
            >
              {project.inPoint !== null && project.outPoint !== null && (
                <div
                  className="absolute inset-y-0 bg-primary/20"
                  style={{
                    left: project.inPoint * pxPerSec,
                    width: Math.max(0, (project.outPoint - project.inPoint) * pxPerSec),
                  }}
                />
              )}
              {Array.from({ length: ticks }, (_, i) => {
                const seconds = i * step;
                const m = Math.floor(seconds / 60);
                const s = seconds % 60;
                return (
                  <div
                    key={i}
                    className="absolute top-0 h-full border-l border-border/60 pl-1 text-[10px] leading-7 text-muted-foreground"
                    style={{ left: seconds * pxPerSec }}
                  >
                    {m}:{String(s).padStart(step < 1 ? 4 : 2, "0")}
                  </div>
                );
              })}
              {project.markers.map((marker) => (
                <MarkerPin key={marker.id} marker={marker} pxPerSec={pxPerSec} dispatch={dispatch} />
              ))}
            </div>

            {captionLane > 0 && (
              <div
                className={cn("relative border-b", !project.captionsEnabled && "opacity-50")}
                style={{ height: captionLane }}
              >
                {project.captions.map((cue) => (
                  <button
                    key={cue.id}
                    type="button"
                    title={`${cue.text}\nClick to go there · double-click to edit`}
                    className={cn(
                      "absolute inset-y-0.5 truncate rounded-sm border bg-muted px-1 text-left text-[10px] leading-4 hover:border-primary/60",
                      time >= cue.start && time < cue.end && "border-primary",
                    )}
                    style={{ left: cue.start * pxPerSec, width: Math.max(2, (cue.end - cue.start) * pxPerSec) }}
                    onClick={() => onSeek(cue.start)}
                    onDoubleClick={() => onOpenCaptions?.()}
                  >
                    {cue.text}
                  </button>
                ))}
              </div>
            )}

            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={cn(
                  "relative border-b last:border-b-0",
                  track.locked && "bg-muted/20",
                  tool === "razor" && "cursor-crosshair",
                )}
                style={{ height: heightOf(track) }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) onSelect(null);
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("cutline/asset")) e.preventDefault();
                }}
                onDrop={(e) => {
                  const assetId = e.dataTransfer.getData("cutline/asset");
                  if (!assetId) return;
                  e.preventDefault();
                  onDropAsset(assetId, track.id, snap(timeAtClientX(e.clientX)));
                }}
              >
                {track.clips.map((clip) => {
                  const asset = assetOf(project, clip);
                  // A thin lane of titles and shapes: the clip fills it and its label shrinks to fit.
                  const thin = heightOf(track) < 30;
                  const linked = linkSize(project, clip) > 1;
                  const isSelected =
                    selected?.trackId === track.id && selected.clipId === clip.id;
                  const ref: ClipRef = { trackId: track.id, clipId: clip.id };
                  const width = Math.max(4, clip.duration * pxPerSec);
                  return (
                    <ContextMenu key={clip.id}>
                      <ContextMenuTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label={`${clip.name}, ${clip.duration.toFixed(1)} seconds on ${track.name}`}
                          aria-pressed={isSelected}
                          className={cn(
                            "group absolute overflow-hidden rounded border select-none",
                            thin ? "top-px bottom-px" : "top-1 bottom-1",
                            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            clipStyle(project, clip),
                            tool === "select" && "cursor-grab active:cursor-grabbing",
                            isSelected && "ring-2 ring-primary",
                            (!clip.enabled || track.hidden || track.muted) && "opacity-45",
                            asset?.offline && "border-destructive bg-destructive/20",
                          )}
                          style={{ left: clip.start * pxPerSec, width }}
                          onPointerDown={(e) => beginDrag(e, "move", ref, clip)}
                          onFocus={() => onSelect(ref)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSelect(ref);
                            }
                          }}
                        >
                          {asset?.thumbnail && track.kind === "video" && width > 40 && !thin && (
                            <img
                              src={asset.thumbnail}
                              alt=""
                              className="pointer-events-none absolute inset-y-0 left-0 h-full w-10 object-cover opacity-60"
                            />
                          )}
                          {asset?.peaks && track.kind === "audio" && (
                            <Waveform clip={clip} peaks={asset.peaks} width={width} height={heightOf(track) - 8} />
                          )}

                          {clip.transitionIn.type !== "none" && (
                            <div
                              className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-white/30 to-transparent"
                              style={{ width: Math.min(width / 2, clip.transitionIn.duration * pxPerSec) }}
                            />
                          )}
                          {clip.transitionOut.type !== "none" && (
                            <div
                              className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-white/30 to-transparent"
                              style={{ width: Math.min(width / 2, clip.transitionOut.duration * pxPerSec) }}
                            />
                          )}

                          <div className="pointer-events-none relative flex h-full items-center gap-1 px-1.5">
                            <span className={cn("truncate font-medium text-foreground/90", thin ? "text-[10px] leading-none" : "text-[11px]")}>
                              {clip.name}
                            </span>
                            {clip.speed !== 1 && (
                              <span className="shrink-0 rounded bg-black/40 px-1 text-[9px]">
                                {clip.speed.toFixed(2)}×
                              </span>
                            )}
                            {clip.reversed && (
                              <span className="shrink-0 rounded bg-black/40 px-1 text-[9px]">rev</span>
                            )}
                            {clip.keyframes.length > 0 && (
                              <span className="shrink-0 rounded bg-primary/50 px-1 text-[9px]">
                                {clip.keyframes.length}k
                              </span>
                            )}
                            {linked && width > 60 && (
                              <Link2
                                className="ml-auto size-3 shrink-0 opacity-70"
                                aria-label="Linked to the rest of the take"
                              />
                            )}
                          </div>

                          <div
                            className="absolute inset-y-0 left-0 w-1.5 cursor-w-resize group-hover:bg-white/30"
                            onPointerDown={(e) => beginDrag(e, "in", ref, clip)}
                          />
                          <div
                            className="absolute inset-y-0 right-0 w-1.5 cursor-e-resize group-hover:bg-white/30"
                            onPointerDown={(e) => beginDrag(e, "out", ref, clip)}
                          />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onClick={() => dispatch({ type: "splitClip", ref, time })}>
                          Split at playhead
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => dispatch({ type: "duplicateClip", ref })}>
                          Duplicate
                        </ContextMenuItem>
                        <ContextMenuItem
                          onClick={() =>
                            dispatch({ type: "patchClip", ref, patch: { enabled: !clip.enabled } })
                          }
                        >
                          {clip.enabled ? "Disable" : "Enable"}
                        </ContextMenuItem>
                        {clip.component && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() => {
                                // Everything one macro call or storyboard component made, as one undo step.
                                const refs = project.tracks.flatMap((t) =>
                                  t.locked ? [] : t.clips.filter((c) => c.component === clip.component && c.scene === clip.scene).map((c) => ({ trackId: t.id, clipId: c.id })),
                                );
                                refs.forEach((r, i) => dispatch({ type: "deleteClip", ref: r }, i > 0));
                              }}
                            >
                              Delete all of “{clip.component}”
                            </ContextMenuItem>
                          </>
                        )}
                        {clip.kind === "media" && asset?.hasAudio && onAutoCaption && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={() => onAutoCaption(asset.id)}>
                              <Sparkles className="size-3.5" />
                              Generate captions
                            </ContextMenuItem>
                            {asset.transcript && (
                              <ContextMenuItem onClick={() => onAutoCaption(asset.id, { force: true })}>
                                Transcribe again
                              </ContextMenuItem>
                            )}
                          </>
                        )}
                        {linked && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={() => dispatch({ type: "detachAudio", ref })}>
                              <Link2Off className="size-3.5" />
                              Detach audio
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => dispatch({ type: "unlinkClip", ref })}>
                              <Link2Off className="size-3.5" />
                              Unlink whole take
                            </ContextMenuItem>
                          </>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => dispatch({ type: "deleteClip", ref })}>
                          Delete
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => dispatch({ type: "rippleDelete", ref })}>
                          Ripple delete
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            ))}

            <div
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-500"
              style={{ left: time * pxPerSec }}
            >
              <div className="absolute top-0 -left-[5px] size-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MarkerPin({
  marker,
  pxPerSec,
  dispatch,
}: {
  marker: Marker;
  pxPerSec: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="absolute bottom-0 z-10 size-0 -translate-x-1/2 cursor-pointer border-x-[5px] border-b-[8px] border-x-transparent"
          style={{ left: marker.time * pxPerSec, borderBottomColor: marker.color }}
          title={marker.name}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled>{marker.name}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => dispatch({ type: "deleteMarker", markerId: marker.id })}>
          Delete marker
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TrackHeader({
  track,
  index,
  total,
  height,
  dispatch,
}: {
  track: Track;
  index: number;
  total: number;
  height: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  const patch = (p: Partial<Track>) => dispatch({ type: "patchTrack", trackId: track.id, patch: p });
  const button = height < 24 ? "size-4 shrink-0" : "size-5 shrink-0";

  return (
    <div className="flex items-center gap-0.5 border-b px-1.5 last:border-b-0" style={{ height }}>
      {track.kind === "video" ? (
        <Video className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <Music className="size-3 shrink-0 text-muted-foreground" />
      )}
      <input
        value={track.name}
        onChange={(e) => patch({ name: e.target.value })}
        className="min-w-0 flex-1 bg-transparent text-[11px] font-medium outline-none focus:rounded focus:bg-accent focus:px-1"
      />
      {track.solo && <Headphones className="size-3 shrink-0 text-primary" />}
      {track.kind === "video" && (
        <Button
          variant="ghost"
          size="icon"
          className={button}
          title={track.hidden ? "Show track" : "Hide track"}
          onClick={() => patch({ hidden: !track.hidden })}
        >
          {track.hidden ? <EyeOff className="size-3 text-muted-foreground" /> : <Eye className="size-3" />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={button}
        title={track.muted ? "Unmute" : "Mute"}
        onClick={() => patch({ muted: !track.muted })}
      >
        {track.muted ? <VolumeX className="size-3 text-muted-foreground" /> : <Volume2 className="size-3" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={button}
        title={track.locked ? "Unlock track" : "Lock track"}
        onClick={() => patch({ locked: !track.locked })}
      >
        {track.locked ? <Lock className="size-3 text-amber-400" /> : <Unlock className="size-3" />}
      </Button>
      {/* Solo, order and delete sit one click away: they are the rare ones, and
          five buttons in a row is what made every track two lines tall. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className={button} title="Solo, order, delete">
            <EllipsisVertical className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="text-xs">
          <DropdownMenuItem onClick={() => patch({ solo: !track.solo })}>
            <Headphones className="size-3.5" />
            {track.solo ? "Stop soloing" : "Solo"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === total - 1} onClick={() => dispatch({ type: "moveTrack", trackId: track.id, delta: 1 })}>
            <ChevronUp className="size-3.5" />
            Move up a layer
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === 0} onClick={() => dispatch({ type: "moveTrack", trackId: track.id, delta: -1 })}>
            <ChevronDown className="size-3.5" />
            Move down a layer
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => dispatch({ type: "deleteTrack", trackId: track.id })}>
            <Trash2 className="size-3.5" />
            Delete track
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

