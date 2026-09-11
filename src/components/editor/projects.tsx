import { useCallback, useEffect, useState } from "react";
import { Copy, FilePlus2, FolderOpen, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { listSessions } from "@/lib/media-store";
import { syncLocalRecordings } from "@/lib/sync";
import type { SessionMeta } from "@/recorder/types";
import { importSession } from "@/editor/media";
import { createProject, projectFromSession } from "@/editor/project";
import {
  clearRecovery,
  deleteProject,
  detectOfflineMedia,
  duplicateProject,
  listProjects,
  loadProject,
  readRecovery,
  saveProject,
  type ProjectSummary,
} from "@/editor/persistence";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDate, formatDuration } from "@/lib/format";

export function Projects({ onOpen }: { onOpen: (project: Project) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(() => readRecovery());
  const [serverError, setServerError] = useState<string | null>(null);

  const reload = useCallback(() => {
    // A server that is not running must say so. Left unhandled, the rejection
    // leaves the list as a loading skeleton forever, which reads as "slow"
    // rather than "start the server".
    listProjects()
      .then((list) => {
        setServerError(null);
        setProjects(list);
      })
      .catch((err: unknown) => {
        setServerError(err instanceof Error ? err.message : "Could not reach the Cutline server.");
        setProjects([]);
      });
    // Takes still in the browser go up first, or a recording made a moment ago
    // would be missing from "start from a recording".
    void syncLocalRecordings()
      .catch(() => undefined)
      .then(() => listSessions())
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  useEffect(reload, [reload]);

  const open = async (id: string) => {
    setBusy("Opening…");
    try {
      // Sync before checking for offline media, or every asset still in the
      // browser would be marked missing.
      await syncLocalRecordings().catch(() => undefined);
      const project = await loadProject(id);
      if (!project) {
        toast.error("That project could not be read.");
        return;
      }
      // Media can disappear between sessions; saying which file is gone beats
      // rendering black where a clip used to be.
      const checked = await detectOfflineMedia(project);
      const missing = checked.assets.filter((a) => a.offline);
      if (missing.length > 0) {
        toast.warning(`${missing.length} source file${missing.length > 1 ? "s are" : " is"} missing`);
      }
      onOpen(checked);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open the project.");
    } finally {
      setBusy(null);
    }
  };

  const fromRecording = async (session: SessionMeta) => {
    setBusy(`Preparing ${session.name}…`);
    try {
      const assets = await importSession(
        session,
        (p) => {
          // Proxy generation is a transcode and is by far the slowest stage, so
          // it is the one that has to show a number rather than a spinner.
          const pct = p.fraction === undefined ? "" : ` ${Math.round(p.fraction * 100)}%`;
          setBusy(`${p.stage}${pct} · ${p.name} (${p.index + 1}/${p.total})`);
        },
        // The rest of the take still opens; say which part did not, and why.
        (fileName, reason) => toast.warning(`Left out ${fileName}: ${reason}`),
      );
      const project = projectFromSession(session, assets);
      await saveProject(project);
      onOpen(project);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open that recording.");
    } finally {
      setBusy(null);
    }
  };

  const blank = async () => {
    const project = createProject();
    try {
      await saveProject(project);
      onOpen(project);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the project.");
    }
  };

  if (busy) {
    return (
      <Card className="flex h-64 items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {busy}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {recovery && (
        <Alert>
          <RotateCcw className="size-4" />
          <AlertTitle>Unsaved work recovered</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span className="text-xs">
              “{recovery.project.name}” was open when the tab closed on{" "}
              {formatDate(recovery.savedAt)}.
            </span>
            <Button size="sm" className="h-7 text-xs" onClick={() => onOpen(recovery.project)}>
              Restore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                clearRecovery();
                setRecovery(null);
              }}
            >
              Discard
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-extrabold">Projects</h1>
        <Button size="sm" className="ml-auto h-9 rounded-full px-4 text-xs font-semibold" onClick={() => void blank()}>
          <FilePlus2 className="size-3.5" />
          New project
        </Button>
      </div>

      {serverError && (
        <Alert variant="destructive">
          <AlertTitle>Projects are unavailable</AlertTitle>
          <AlertDescription className="text-xs">
            {serverError} Projects are saved by the local server, so nothing can be
            opened or saved until it is running. Recording still works.
          </AlertDescription>
        </Alert>
      )}

      {projects === null ? (
        <Card className="h-28 animate-pulse" />
      ) : projects.length === 0 ? (
        <Card className="flex h-28 items-center justify-center border-dashed">
          <p className="text-xs text-muted-foreground">
            No projects yet — start one from a recording below, or create a blank one.
          </p>
        </Card>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((summary) => (
            <Card key={summary.id} className="gap-0 p-3">
              <button className="text-left" onClick={() => void open(summary.id)}>
                <p className="truncate text-sm font-medium">{summary.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatDuration(summary.durationSec * 1000)} · {summary.trackCount} tracks ·{" "}
                  {summary.assetCount} sources
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Edited {formatDate(summary.updatedAt)}
                </p>
              </button>
              <div className="mt-2 flex gap-1">
                <Button size="sm" variant="secondary" className="h-6 flex-1 text-[11px]" onClick={() => void open(summary.id)}>
                  <FolderOpen className="size-3" />
                  Open
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  title="Duplicate"
                  onClick={async () => {
                    const project = await loadProject(summary.id);
                    if (!project) return;
                    await duplicateProject(project);
                    reload();
                    toast.success("Project duplicated");
                  }}
                >
                  <Copy className="size-3" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="icon" variant="ghost" className="size-6" title="Delete">
                      <Trash2 className="size-3" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete “{summary.name}”?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The edit is deleted. The recordings and imported files it referenced
                        are left alone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={async () => {
                          await deleteProject(summary.id);
                          reload();
                        }}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </Card>
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <>
          <h2 className="pt-2 text-sm font-bold">Start from a recording</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {sessions.map((session) => (
              <Card key={session.id} className="gap-0 p-3">
                <p className="truncate text-sm font-medium">{formatDate(session.createdAt)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatDuration(session.durationMs)} · {session.tracks.length} tracks
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2 h-6 text-[11px]"
                  onClick={() => void fromRecording(session)}
                >
                  New project from this
                </Button>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
