import { useCallback, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
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
} from "lucide-react";
import type { Action } from "@/editor/project";
import { assetOf, linkSize, snapPoints } from "@/editor/project";
import type { Clip, ClipRef, Marker, Project, Track } from "@/editor/types";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

const HEADER_WIDTH = 150;
const RULER_HEIGHT = 28;
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
}) {
  const [pxPerSec, setPxPerSec] = useState(70);
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

  const trackAtClientY = useCallback(
    (clientY: number): Track | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      const rect = lanes.getBoundingClientRect();
      let offset = rect.top + RULER_HEIGHT - lanes.scrollTop;
      for (const track of project.tracks) {
        if (clientY >= offset && clientY < offset + track.height) return track;
        offset += track.height;
      }
      return null;
    },
    [project.tracks],
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
  const totalHeight = project.tracks.reduce((n, t) => n + t.height, 0);

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
          {project.tracks.map((track, index) => (
            <TrackHeader
              key={track.id}
              track={track}
              index={index}
              total={project.tracks.length}
              dispatch={dispatch}
            />
          ))}
        </div>

        <div ref={lanesRef} className="relative min-w-0 flex-1 overflow-auto">
          <div style={{ width: contentWidth, minHeight: totalHeight + RULER_HEIGHT }}>
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

            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={cn(
                  "relative border-b last:border-b-0",
                  track.locked && "bg-muted/20",
                  tool === "razor" && "cursor-crosshair",
                )}
                style={{ height: track.height }}
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
                            "group absolute top-1 bottom-1 overflow-hidden rounded border select-none",
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
                          {asset?.thumbnail && track.kind === "video" && width > 40 && (
                            <img
                              src={asset.thumbnail}
                              alt=""
                              className="pointer-events-none absolute inset-y-0 left-0 h-full w-10 object-cover opacity-60"
                            />
                          )}
                          {asset?.peaks && track.kind === "audio" && (
                            <Waveform clip={clip} peaks={asset.peaks} width={width} height={track.height - 8} />
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
                            <span className="truncate text-[11px] font-medium text-foreground/90">
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
  dispatch,
}: {
  track: Track;
  index: number;
  total: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  const patch = (p: Partial<Track>) => dispatch({ type: "patchTrack", trackId: track.id, patch: p });

  return (
    <div
      className="flex flex-col justify-center gap-0.5 border-b px-1.5 last:border-b-0"
      style={{ height: track.height }}
    >
      <div className="flex items-center gap-1">
        {track.kind === "video" ? (
          <Video className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <Music className="size-3 shrink-0 text-muted-foreground" />
        )}
        <input
          value={track.name}
          onChange={(e) => patch({ name: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-[11px] font-medium outline-none focus:bg-accent focus:px-1 focus:rounded"
        />
        <div className="flex shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            title={index === 0 ? "Already at the bottom" : "Move down a layer"}
            disabled={index === 0}
            onClick={() => dispatch({ type: "moveTrack", trackId: track.id, delta: -1 })}
          >
            <ChevronDown className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            title={index === total - 1 ? "Already on top" : "Move up a layer"}
            disabled={index === total - 1}
            onClick={() => dispatch({ type: "moveTrack", trackId: track.id, delta: 1 })}
          >
            <ChevronUp className="size-3" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        {track.kind === "video" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            title={track.hidden ? "Show track" : "Hide track"}
            onClick={() => patch({ hidden: !track.hidden })}
          >
            {track.hidden ? <EyeOff className="size-3 text-muted-foreground" /> : <Eye className="size-3" />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          title={track.muted ? "Unmute" : "Mute"}
          onClick={() => patch({ muted: !track.muted })}
        >
          {track.muted ? <VolumeX className="size-3 text-muted-foreground" /> : <Volume2 className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-5", track.solo && "text-primary")}
          title="Solo"
          onClick={() => patch({ solo: !track.solo })}
        >
          <Headphones className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          title={track.locked ? "Unlock track" : "Lock track"}
          onClick={() => patch({ locked: !track.locked })}
        >
          {track.locked ? <Lock className="size-3 text-amber-400" /> : <Unlock className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-5"
          title="Delete track"
          onClick={() => dispatch({ type: "deleteTrack", trackId: track.id })}
        >
          <Trash2 className="size-3 text-muted-foreground" />
        </Button>
      </div>
    </div>
  );
}
