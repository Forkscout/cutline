import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { clipBox, hitTest, visibleClips, type ClipBox } from "@/editor/compositor";
import { clipAt } from "@/editor/keyframes";
import type { Action } from "@/editor/project";
import { assetOf } from "@/editor/project";
import type { Clip, ClipRef, Project, Track } from "@/editor/types";
import { cn } from "@/lib/utils";

/** Snap a layer's centre to these fractions of the frame while dragging. */
const SNAP_TARGETS = [0.5, 1 / 3, 2 / 3, 0, 1];
/** Snapping tolerance in screen pixels, so it feels the same at any zoom. */
const SNAP_PX = 7;
/** Shift-rotation lands on multiples of this. */
const ROTATE_STEP = 15;

type Handle =
  | "move"
  | "nw" | "ne" | "se" | "sw"
  | "n" | "e" | "s" | "w"
  | "rotate";

const CORNERS: { id: Handle; x: number; y: number; cursor: string }[] = [
  { id: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { id: "ne", x: 1, y: 0, cursor: "nesw-resize" },
  { id: "se", x: 1, y: 1, cursor: "nwse-resize" },
  { id: "sw", x: 0, y: 1, cursor: "nesw-resize" },
];

const EDGES: { id: Handle; x: number; y: number; cursor: string }[] = [
  { id: "n", x: 0.5, y: 0, cursor: "ns-resize" },
  { id: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { id: "s", x: 0.5, y: 1, cursor: "ns-resize" },
  { id: "w", x: 0, y: 0.5, cursor: "ew-resize" },
];

interface Layer {
  track: Track;
  clip: Clip;
  box: ClipBox;
}

/**
 * Direct manipulation on the program monitor.
 *
 * Every box here comes from `clipBox` in the compositor — the same maths the
 * renderer lays the layer out with. A second implementation would line up on
 * the day it was written and drift the first time either side changed, which is
 * exactly the failure the shared `drawFrame` exists to prevent, one level down.
 */
export function MonitorOverlay({
  project,
  time,
  canvas,
  selected,
  onSelect,
  dispatch,
  noting = false,
  onNoted,
}: {
  project: Project;
  time: number;
  canvas: HTMLCanvasElement | null;
  selected: ClipRef | null;
  onSelect: (ref: ClipRef | null) => void;
  dispatch: (action: Action, coalesce?: boolean) => void;
  /** The next click on the picture drops a note there. */
  noting?: boolean;
  onNoted?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [guide, setGuide] = useState<{ x?: number; y?: number }>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  // Focus lands in a note's card once it is open, after the press that opened it.
  useEffect(() => {
    if (openNote) noteField.current?.focus();
  }, [openNote]);

  // The canvas is laid out by the browser (fit, or a zoom factor), so the only
  // reliable source for its on-screen size is measurement.
  useEffect(() => {
    if (!canvas) return;
    const host = hostRef.current?.parentElement;
    const measure = () => {
      const cr = canvas.getBoundingClientRect();
      const hr = host?.getBoundingClientRect();
      if (!hr) return;
      setRect({ left: cr.left - hr.left, top: cr.top - hr.top, width: cr.width, height: cr.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    if (host) observer.observe(host);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
    };
  }, [canvas, project.width, project.height]);

  /** Visible video layers in compositing order, with their drawn boxes. */
  const layers: Layer[] = [];
  let baseTaken = false;
  for (const { track, clip: raw } of visibleClips(project, time)) {
    if (track.kind !== "video") continue;
    const clip = clipAt(raw, time - raw.start);
    const asset = assetOf(project, clip);
    if (clip.kind === "media" && !asset?.hasVideo) continue;
    const isBase = clip.kind === "media" && !baseTaken;
    if (isBase) baseTaken = true;
    const box = clipBox(project, clip, asset ? { width: asset.width, height: asset.height } : null, isBase);
    if (box) layers.push({ track, clip: raw, box });
  }

  const scale = rect ? rect.width / project.width : 1;
  const selectedLayer = layers.find(
    (l) => selected && l.track.id === selected.trackId && l.clip.id === selected.clipId,
  );

  const toProject = useCallback(
    (clientX: number, clientY: number) => {
      if (!canvas) return { x: 0, y: 0 };
      const cr = canvas.getBoundingClientRect();
      return {
        x: ((clientX - cr.left) / cr.width) * project.width,
        y: ((clientY - cr.top) / cr.height) * project.height,
      };
    },
    [canvas, project.width, project.height],
  );

  const beginDrag = (event: React.PointerEvent, handle: Handle, layer: Layer) => {
    // Only the primary button drags; anything else belongs to the browser.
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (layer.track.locked) return;

    const ref: ClipRef = { trackId: layer.track.id, clipId: layer.clip.id };
    onSelect(ref);

    const t = layer.clip.transform;
    const start = toProject(event.clientX, event.clientY);
    const origin = {
      x: t.x,
      y: t.y,
      scale: t.scale,
      scaleX: t.scaleX,
      scaleY: t.scaleY,
      rotation: t.rotation,
    };
    const box = layer.box;
    const startAngle = Math.atan2(start.y - box.cy, start.x - box.cx);
    const startDistance = Math.hypot(start.x - box.cx, start.y - box.cy) || 1;
    // The first move opens a history entry; the rest fold into it, so one drag
    // costs one undo rather than a hundred.
    let first = true;

    const move = (ev: PointerEvent) => {
      const now = toProject(ev.clientX, ev.clientY);
      const patch: Record<string, number> = {};
      const marks: { x?: number; y?: number } = {};

      if (handle === "move") {
        let nx = origin.x + (now.x - start.x) / project.width;
        let ny = origin.y + (now.y - start.y) / project.height;

        if (project.guides.snapToGuides && !ev.shiftKey) {
          const tolX = SNAP_PX / (scale * project.width);
          const tolY = SNAP_PX / (scale * project.height);
          for (const target of SNAP_TARGETS) {
            if (Math.abs(nx - target) < tolX) {
              nx = target;
              marks.x = target;
            }
            if (Math.abs(ny - target) < tolY) {
              ny = target;
              marks.y = target;
            }
          }
        }
        patch.x = nx;
        patch.y = ny;
      } else if (handle === "rotate") {
        const angle = Math.atan2(now.y - box.cy, now.x - box.cx);
        let degrees = origin.rotation + ((angle - startAngle) * 180) / Math.PI;
        if (ev.shiftKey) degrees = Math.round(degrees / ROTATE_STEP) * ROTATE_STEP;
        // Keep it in the range the inspector's slider can show.
        patch.rotation = ((degrees + 180) % 360 + 360) % 360 - 180;
      } else if (handle === "n" || handle === "s") {
        const ratio = Math.abs(now.y - box.cy) / Math.max(1, Math.abs(start.y - box.cy));
        patch.scaleY = Math.max(0.02, origin.scaleY * ratio);
      } else if (handle === "e" || handle === "w") {
        const ratio = Math.abs(now.x - box.cx) / Math.max(1, Math.abs(start.x - box.cx));
        patch.scaleX = Math.max(0.02, origin.scaleX * ratio);
      } else {
        // Corners scale uniformly, measured as distance from the rotation
        // centre — which keeps working however the layer is rotated.
        const ratio = Math.hypot(now.x - box.cx, now.y - box.cy) / startDistance;
        patch.scale = Math.max(0.02, Math.min(8, origin.scale * ratio));
      }

      setGuide(marks);
      dispatch({ type: "setTransform", ref, patch }, !first);
      first = false;
    };

    const up = () => {
      setGuide({});
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Topmost layer under the pointer, so a PiP wins over the screen beneath it. */
  const layerAt = (clientX: number, clientY: number): Layer | null => {
    const p = toProject(clientX, clientY);
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      if (layer && hitTest(layer.box, p.x, p.y)) return layer;
    }
    return null;
  };

  /** Notes pinned to the picture, numbered in time order; shown around their moment. */
  const notes = project.markers.filter((m) => m.pin).sort((a, b) => a.time - b.time);
  const pins = notes.filter((m) => time >= m.time - 0.25 && time <= m.time + Math.max(m.duration, 1.5));
  const note = notes.find((m) => m.id === openNote);
  const dropNote = (clientX: number, clientY: number) => {
    const p = toProject(clientX, clientY);
    const id = crypto.randomUUID();
    const pin = { x: Math.max(0, Math.min(1, p.x / project.width)), y: Math.max(0, Math.min(1, p.y / project.height)) };
    dispatch({ type: "addMarker", marker: { id, time, duration: 0, name: "Note", note: "", color: "#F59E0B", author: "client", pin } });
    setOpenNote(id);
    onNoted?.();
  };
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  if (!rect) return <div ref={hostRef} className="pointer-events-none absolute inset-0" />;

  const px = (value: number) => value * scale;

  return (
    <div
      ref={hostRef}
      className="absolute"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        cursor: noting ? "crosshair" : hovered ? "move" : "default",
      }}
      onPointerMove={(e) => {
        const layer = layerAt(e.clientX, e.clientY);
        setHovered(layer ? layer.clip.id : null);
      }}
      onPointerLeave={() => setHovered(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (noting) {
          // Otherwise the press on the picture takes focus back from the note's card, and
          // what the client types goes to the editor's shortcuts instead.
          e.preventDefault();
          dropNote(e.clientX, e.clientY);
          return;
        }
        const layer = layerAt(e.clientX, e.clientY);
        if (!layer) {
          onSelect(null);
          return;
        }
        beginDrag(e, "move", layer);
      }}
    >
      {pins.map((m) => (
        <button
          key={m.id}
          className={cn(
            "absolute z-20 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold shadow",
            m.resolved ? "bg-muted text-muted-foreground" : "bg-amber-400 text-black",
          )}
          style={{ left: px(m.pin!.x * project.width), top: px(m.pin!.y * project.height) }}
          title={m.note || "Note"}
          aria-label={`Note ${notes.indexOf(m) + 1}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setOpenNote(openNote === m.id ? null : m.id)}
        >
          {notes.indexOf(m) + 1}
        </button>
      ))}
      {note?.pin && (
        <div
          className="absolute z-30 w-56 space-y-1.5 rounded-md border bg-popover p-2 text-[11px] text-popover-foreground shadow-lg"
          style={{
            left: Math.max(0, Math.min(px(note.pin.x * project.width) + 14, rect.width - 232)),
            top: Math.max(0, Math.min(px(note.pin.y * project.height) - 8, rect.height - 160)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>
              Note {notes.indexOf(note) + 1} · {mmss(note.time)}
              {note.author === "agent" ? " · from the agent" : ""}
            </span>
            <button className="ml-auto hover:text-foreground" aria-label="Close note" onClick={() => setOpenNote(null)}>
              ✕
            </button>
          </div>
          <Textarea
            ref={noteField}
            rows={3}
            value={note.note}
            placeholder="What should change here?"
            className="min-h-0 resize-none text-[11px]"
            onChange={(e) => dispatch({ type: "patchMarker", markerId: note.id, patch: { note: e.target.value } }, true)}
          />
          {note.reply && <p className="text-[10px] text-muted-foreground">Done: {note.reply}</p>}
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[10px]"
              onClick={() =>
                dispatch({
                  type: "patchMarker",
                  markerId: note.id,
                  patch: note.resolved ? { resolved: false, color: "#F59E0B" } : { resolved: true, color: "#71717A" },
                })
              }
            >
              {note.resolved ? "Reopen" : "Resolve"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[10px]"
              onClick={() => {
                dispatch({ type: "deleteMarker", markerId: note.id });
                setOpenNote(null);
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
      {/* An outline follows the pointer over unselected layers, so it is
          discoverable that the picture itself can be grabbed. CSS :hover cannot
          do this — the boxes have to stay pointer-transparent for hit testing
          to reach the container, and a pointer-events:none element is never a
          hover target. */}
      {hovered && hovered !== selectedLayer?.clip.id && (
        (() => {
          const layer = layers.find((l) => l.clip.id === hovered);
          if (!layer) return null;
          return (
            <div
              className="pointer-events-none absolute border border-primary/70"
              style={{
                left: px(layer.box.cx + layer.box.x),
                top: px(layer.box.cy + layer.box.y),
                width: px(layer.box.w),
                height: px(layer.box.h),
                transform: `rotate(${layer.box.rotation}deg)`,
                transformOrigin: `${px(-layer.box.x)}px ${px(-layer.box.y)}px`,
              }}
            />
          );
        })()
      )}

      {guide.x !== undefined && (
        <div className="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: guide.x * rect.width }} />
      )}
      {guide.y !== undefined && (
        <div className="pointer-events-none absolute inset-x-0 h-px bg-primary" style={{ top: guide.y * rect.height }} />
      )}

      {selectedLayer && (
        <div
          className="absolute"
          style={{
            left: px(selectedLayer.box.cx + selectedLayer.box.x),
            top: px(selectedLayer.box.cy + selectedLayer.box.y),
            width: px(selectedLayer.box.w),
            height: px(selectedLayer.box.h),
            transform: `rotate(${selectedLayer.box.rotation}deg)`,
            transformOrigin: `${px(-selectedLayer.box.x)}px ${px(-selectedLayer.box.y)}px`,
          }}
        >
          <div
            className={cn(
              "absolute inset-0 border-2 border-primary",
              selectedLayer.track.locked && "border-dashed border-amber-400",
            )}
            style={{ cursor: selectedLayer.track.locked ? "not-allowed" : "move" }}
            onPointerDown={(e) => beginDrag(e, "move", selectedLayer)}
          />

          {!selectedLayer.track.locked && (
            <>
              {[...CORNERS, ...EDGES].map((handle) => (
                <div
                  key={handle.id}
                  onPointerDown={(e) => beginDrag(e, handle.id, selectedLayer)}
                  className="absolute size-2.5 rounded-[2px] border border-primary-foreground bg-primary shadow"
                  style={{
                    left: `calc(${handle.x * 100}% - 5px)`,
                    top: `calc(${handle.y * 100}% - 5px)`,
                    cursor: handle.cursor,
                  }}
                />
              ))}

              <div
                onPointerDown={(e) => beginDrag(e, "rotate", selectedLayer)}
                title="Drag to rotate · hold Shift for 15° steps"
                className="absolute size-3 rounded-full border border-primary-foreground bg-primary shadow"
                style={{ left: "calc(50% - 6px)", top: -28, cursor: "grab" }}
              />
              <div
                className="pointer-events-none absolute w-px bg-primary"
                style={{ left: "50%", top: -22, height: 22 }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
