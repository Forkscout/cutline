/**
 * Compare looks: this frame in three themes side by side, drawn by the same
 * drawFrame as the export. One click chooses; the whole edit restyles.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { reduce, type Action } from "@/editor/project";
import { renderStill } from "@/editor/snapshot";
import { THEMES, themeById, themeOf } from "@/editor/themes";
import type { Project, Theme } from "@/editor/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const selectClass = "h-6 w-full rounded-md border bg-transparent px-1 text-[11px]";

export function StyleframeCompare({
  open,
  onOpenChange,
  project,
  time,
  dispatch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  time: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  const current = themeOf(project);
  const [picks, setPicks] = useState<string[]>([]);
  const [stills, setStills] = useState<Record<string, string>>({});
  const [at, setAt] = useState(time);

  useEffect(() => {
    if (!open) return;
    setAt(time);
    setPicks([current.id, ...THEMES.map((t) => t.id).filter((id) => id !== current.id).slice(0, 2)]);
    // The frame is chosen when the dialog opens; the playhead may move behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const themeFor = (id: string): Theme => (id === current.id ? current : themeById(id));
  const key = picks.join("|");
  useEffect(() => {
    if (!open || picks.length === 0) return;
    let live = true;
    setStills({});
    for (const id of picks) {
      const restyled = reduce(project, { type: "setTheme", theme: themeFor(id), restyle: true });
      void renderStill(restyled, at, 640)
        .then((s) => live && setStills((prev) => ({ ...prev, [id]: `data:${s.mimeType};base64,${s.data}` })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // Drawn once per choice of themes, not on every edit behind the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, at]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 p-4 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Compare looks at {mmss(at)}</DialogTitle>
          <DialogDescription className="text-[11px]">
            The same frame in each theme, as the export will draw it. Choosing one restyles every graphic made from the theme.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {picks.map((id, i) => {
            const theme = themeFor(id);
            const chosen = project.theme?.id === id;
            return (
              <div key={`${i}-${id}`} className="space-y-1.5">
                <select className={selectClass} value={id} onChange={(e) => setPicks(picks.map((p, j) => (j === i ? e.target.value : p)))}>
                  {[...new Set([current.id, ...THEMES.map((t) => t.id)])].map((option) => (
                    <option key={option} value={option}>
                      {themeFor(option).name}
                      {option === current.id && project.theme ? " (current)" : ""}
                    </option>
                  ))}
                </select>
                {stills[id] ? (
                  <img src={stills[id]} alt={`The frame in ${theme.name}`} className="aspect-video w-full rounded border object-cover" />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded border bg-muted/40 text-[10px] text-muted-foreground">Drawing…</div>
                )}
                <p className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">{theme.description}</p>
                <Button
                  size="sm"
                  className="h-7 w-full text-[11px]"
                  variant={chosen ? "secondary" : "default"}
                  disabled={chosen}
                  onClick={() => {
                    dispatch({ type: "setTheme", theme, restyle: true });
                    toast.success(`The look is now ${theme.name}`);
                    onOpenChange(false);
                  }}
                >
                  {chosen ? "Current look" : `Use ${theme.name}`}
                </Button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
