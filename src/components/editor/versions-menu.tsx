/**
 * Versions: named snapshots of the project, saved beside it. Restoring one is
 * an ordinary edit — what it replaces stays in History, one undo away.
 */

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { toast } from "sonner";
import type { Action } from "@/editor/project";
import { listVersions, loadVersion, saveVersion, type VersionSummary } from "@/editor/persistence";
import type { Project } from "@/editor/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

/** "v3 · notes pass", unless the label already carries its number. */
const named = (v: VersionSummary) => (/^v\d+\b/i.test(v.label) ? v.label : `v${v.n} · ${v.label}`);

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function VersionsMenu({ project, dispatch }: { project: Project; dispatch: (action: Action, coalesce?: boolean) => void }) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState("");
  const [restoring, setRestoring] = useState<VersionSummary | null>(null);
  const refresh = () => listVersions(project.id).then(setVersions).catch(() => setVersions([]));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  const latest = versions?.[0];

  const save = async () => {
    try {
      const saved = await saveVersion(project, label || `Version ${(latest?.n ?? 0) + 1}`);
      toast.success(`Saved ${named(saved)}`);
      setNaming(false);
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the version.");
    }
  };
  const restore = async (v: VersionSummary) => {
    try {
      dispatch({ type: "restoreVersion", project: await loadVersion(project.id, v.id), label: v.label });
      toast.success(`Restored ${named(v)}`, { description: "What it replaced is in History: undo brings it back." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restore the version.");
    }
  };

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void refresh()}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="ml-1 h-7 gap-1 px-2 text-[11px] text-muted-foreground" title="Versions">
            <Layers className="size-3" />
            {latest ? named(latest) : "Versions"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem
            onClick={() => {
              setLabel("");
              setNaming(true);
            }}
          >
            Save this version…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {versions === null ? (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">No versions yet. Save one before a big change.</p>
          ) : (
            versions.map((v) => (
              <DropdownMenuItem key={v.id} className="flex-col items-start gap-0" onClick={() => setRestoring(v)}>
                <span className="text-[11px]">{named(v)}</span>
                <span className="text-[10px] text-muted-foreground">{when(v.createdAt)}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Save this version</DialogTitle>
            <DialogDescription className="text-[11px]">A name you will recognise later: “before the notes”, “v2 · client cut”.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Version ${(latest?.n ?? 0) + 1}`} className="h-8 text-xs" />
            <DialogFooter className="mt-3">
              <Button type="submit" size="sm">Save version</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(restoring)} onOpenChange={(open) => !open && setRestoring(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore {restoring ? named(restoring) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              The project goes back to how it was on {restoring ? when(restoring.createdAt) : ""}. What you have now stays in History — one undo brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (restoring) void restore(restoring);
                setRestoring(null);
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
