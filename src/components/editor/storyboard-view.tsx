/**
 * The storyboard as cards, in order: what each scene shows, when, in which
 * layout, and what is said in it. Click a card to go there; lock a scene to
 * keep it through compiles, or compile just that scene again.
 */

import { useEffect, useMemo, useState } from "react";
import { Lock, LockOpen, RefreshCw } from "lucide-react";
import type { Action } from "@/editor/project";
import { renderStill } from "@/editor/snapshot";
import { AnchorError, resolveAnchor } from "@/editor/storyboard";
import { wordsOnTimeline } from "@/editor/transcript";
import type { Project, StoryComponent, StoryScene } from "@/editor/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const summary = (c: StoryComponent): string => {
  switch (c.type) {
    case "title":
      return c.title;
    case "points":
      return c.items.map((i) => i.text).join(" · ");
    case "chips":
      return c.items.map((i) => i.text).join(" · ");
    case "stat":
      return `${c.value}${c.label ? ` — ${c.label}` : ""}`;
    case "statement":
      return c.lines.map((l) => l.text).join(" ");
    case "flow":
      return c.steps.map((s) => s.text).join(" → ");
    case "cards":
      return c.cards.map((k) => k.title).join(" | ");
    case "split":
      return `${c.source.text} → ${c.branches.map((b) => b.title).join(" / ")}`;
    case "bars":
      return c.items.map((i) => i.display ?? String(i.value)).join(", ");
    case "tally":
      return c.items.map((i) => i.value).join(", ");
    case "tree":
      return c.nodes.map((n) => n.label).join(", ");
    case "lower_third":
      return c.name;
    case "table":
      return c.rows.map((r) => { const cell = r.cells[0]; return typeof cell === "object" ? cell.text : (cell ?? ""); }).join(" · ");
    case "stack":
      return c.items.map((i) => i.title).join(" ↓ ");
    case "flash":
      return `flash on ${c.node}`;
    case "coin":
      return c.stops.map((s) => s.node).join(" → ");
  }
};

/** Frames already drawn, by scene and compile: a card keeps its frame until the next compile. */
const thumbs = new Map<string, string>();

function Thumb({ project, scene, at }: { project: Project; scene: StoryScene; at: number | null }) {
  const key = `${project.id}:${scene.id}:${project.storyboard?.compiledAt ?? 0}`;
  const [src, setSrc] = useState(thumbs.get(key) ?? null);
  useEffect(() => {
    if (src || at === null || !project.storyboard?.compiledAt) return;
    let live = true;
    void renderStill(project, at, 224)
      .then((still) => {
        const url = `data:${still.mimeType};base64,${still.data}`;
        thumbs.set(key, url);
        if (live) setSrc(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Drawn once per compile; the project object changes on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, at]);
  return src ? (
    <img src={src} alt="" className="aspect-video w-full rounded-sm border object-cover" />
  ) : (
    <div className="flex aspect-video w-full items-center justify-center rounded-sm border bg-muted/40 text-[9px] text-muted-foreground">
      {project.storyboard?.compiledAt ? "…" : "not compiled"}
    </div>
  );
}

export function StoryboardView({
  project,
  time,
  onSeek,
  onCompile,
  dispatch,
}: {
  project: Project;
  time: number;
  onSeek: (time: number) => void;
  onCompile: (only?: string[]) => void;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  const board = project.storyboard;
  const words = useMemo(() => wordsOnTimeline(project), [project]);
  const times = useMemo(() => {
    if (!board) return [];
    let cursor = 0;
    return board.scenes.map((scene) => {
      try {
        const from = resolveAnchor(scene.from, words, cursor);
        const to = resolveAnchor(scene.to, words, from + 0.01);
        cursor = from;
        return { from, to, error: null as string | null };
      } catch (err) {
        return { from: null, to: null, error: err instanceof AnchorError ? err.message : String(err) };
      }
    });
  }, [board, words]);

  if (!board) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
        No storyboard yet. An agent writes one with set_storyboard — the scenes, their layouts and the words each graphic lands on — and
        compiles it into clips here.
      </div>
    );
  }

  const setLocked = (id: string, locked: boolean) =>
    dispatch({ type: "setStoryboard", storyboard: { ...board, scenes: board.scenes.map((s) => (s.id === id ? { ...s, locked } : s)) } });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-[11px]">
        <span className="font-medium">Storyboard</span>
        <span className="text-muted-foreground">
          {board.scenes.length} scenes ·{" "}
          {board.compiledAt ? `compiled ${new Date(board.compiledAt).toLocaleTimeString(undefined, { timeStyle: "short" })}` : "not compiled"}
        </span>
        <Button size="sm" className="ml-auto h-6 text-[10px]" onClick={() => onCompile()}>
          <RefreshCw className="size-3" /> Compile
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
        {board.scenes.map((scene, i) => {
          const t = times[i]!;
          const active = t.from !== null && t.to !== null && time >= t.from && time < t.to;
          const heard =
            t.from !== null && t.to !== null
              ? words
                  .filter((w) => w.start >= t.from! && w.start < t.to!)
                  .slice(0, 22)
                  .map((w) => w.text)
                  .join(" ")
              : "";
          return (
            <div
              key={scene.id}
              className={cn(
                "flex w-60 shrink-0 cursor-pointer flex-col gap-1.5 overflow-hidden rounded-md border bg-card p-2 text-[10px]",
                active && "border-primary",
                scene.locked && "opacity-80",
              )}
              onClick={() => t.from !== null && onSeek(t.from)}
            >
              <div className="flex items-center gap-1">
                <span className="font-mono text-muted-foreground">{i + 1}</span>
                <span className="truncate font-medium">{scene.id}</span>
                <span className="ml-auto rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">{scene.layout}</span>
                <button
                  className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                  title="Compile this scene again"
                  aria-label={`Regenerate ${scene.id}`}
                  disabled={scene.locked || Boolean(t.error)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCompile([scene.id]);
                  }}
                >
                  <RefreshCw className="size-3" />
                </button>
                <button
                  aria-label={scene.locked ? `Unlock ${scene.id}` : `Lock ${scene.id}`}
                  className="text-muted-foreground hover:text-foreground"
                  title={scene.locked ? "Locked: compiles leave it alone" : "Lock this scene"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLocked(scene.id, !scene.locked);
                  }}
                >
                  {scene.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
              <Thumb project={project} scene={scene} at={t.from !== null && t.to !== null ? Math.min(t.to - 0.2, t.from + (t.to - t.from) * 0.7) : null} />
              <div className="font-mono text-[9px] text-muted-foreground">
                {t.error ? <span className="text-destructive">{t.error}</span> : `${t.from!.toFixed(1)}–${t.to!.toFixed(1)} s`}
              </div>
              {scene.note && <p className="leading-snug">{scene.note}</p>}
              <ul className="space-y-0.5">
                {scene.components.map((c) => (
                  <li key={c.id} className="truncate" title={summary(c)}>
                    <span className="text-muted-foreground">{c.type}</span> {summary(c)}
                  </li>
                ))}
              </ul>
              {heard && <p className="line-clamp-3 leading-snug text-muted-foreground">“{heard}…”</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
