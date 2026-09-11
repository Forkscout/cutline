import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Circle, Clapperboard, Moon, Square, Sun } from "lucide-react";
import type { RecorderPhase } from "@/recorder/types";
import { checkSupport, missingRequirements } from "@/recorder/mime";
import { useTheme } from "@/hooks/use-theme";
import type { Project } from "@/editor/types";
import { Studio, type StudioControls } from "@/components/studio";
import { Library } from "@/components/library";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

// The editor pulls in mediabunny — demuxers, muxers and codec plumbing, about a
// megabyte of it. Someone who only came to record should not download an
// encoder they will not run.
const Editor = lazy(() =>
  import("@/components/editor/editor").then((m) => ({ default: m.Editor })),
);
const Projects = lazy(() =>
  import("@/components/editor/projects").then((m) => ({ default: m.Projects })),
);
const Create = lazy(() => import("@/components/create").then((m) => ({ default: m.Create })));
const WorkspaceStudio = lazy(() => import("@/components/workspace-studio").then((m) => ({ default: m.WorkspaceStudio })));
const EditorErrorBoundary = lazy(() =>
  import("@/components/editor/error-boundary").then((m) => ({ default: m.EditorErrorBoundary })),
);

const Loading = ({ label }: { label: string }) => (
  <div className="flex h-96 items-center justify-center text-sm text-muted-foreground">{label}</div>
);

export function App() {
  const { theme, toggle } = useTheme();
  const support = useMemo(checkSupport, []);
  const missing = useMemo(() => missingRequirements(support), [support]);
  const [tab, setTab] = useState("create");
  /** What Create was asked for, handed to the Director when the editor opens. */
  const [request, setRequest] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [controls, setControls] = useState<StudioControls | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  // Holds the last good document so a crash can be snapshotted rather than lost.
  const liveProject = useRef<Project | null>(null);
  const handleProjectChange = useCallback((p: Project) => {
    liveProject.current = p;
  }, []);

  // `?project=<id>` opens that project directly: a reload stays in the editor,
  // and an agent can hand the user a link to what it just built.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("project");
    if (!id) return;
    void (async () => {
      // Lazily, so mediabunny stays out of the bundle that draws the recorder.
      const [{ loadProject, detectOfflineMedia }, { syncLocalRecordings }] = await Promise.all([
        import("@/editor/persistence"),
        import("@/lib/sync"),
      ]);
      await syncLocalRecordings().catch(() => undefined);
      const project = await loadProject(id).catch(() => null);
      if (project) setEditing(await detectOfflineMedia(project));
      else toast.error("That project could not be opened.");
    })();
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (editing) url.searchParams.set("project", editing.id);
    else if (url.searchParams.has("project")) url.searchParams.delete("project");
    else return;
    window.history.replaceState(null, "", url);
  }, [editing]);

  const handleControls = useCallback((next: StudioControls | null) => setControls(next), []);
  const handleFinished = useCallback(() => {
    setReloadKey((k) => k + 1);
    setTab("library");
  }, []);
  const handleEditorClose = useCallback(() => {
    setEditing(null);
    setRequest(null);
    setReloadKey((k) => k + 1);
  }, []);

  if (missing.length > 0) {
    return (
      <div className="mx-auto max-w-lg px-6 py-24">
        <Alert variant="destructive">
          <AlertTitle>This browser cannot record</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <p className="mt-2">Chrome or Edge on a secure origin has everything needed.</p>
          </AlertDescription>
        </Alert>
        <Toaster position="bottom-center" />
      </div>
    );
  }

  // The editor owns the whole viewport: an NLE fights for every pixel, and
  // wrapping it in the app's page chrome would cost it a header's worth.
  if (editing) {
    return (
      <>
        <Suspense fallback={<Loading label="Loading the editor…" />}>
          <EditorErrorBoundary
            getProject={() => liveProject.current}
            onClose={handleEditorClose}
          >
            <Editor
              key={editing.id}
              initial={editing}
              {...(request ? { initialRequest: request } : {})}
              onClose={handleEditorClose}
              onProjectChange={handleProjectChange}
            />
          </EditorErrorBoundary>
        </Suspense>
        <Toaster position="bottom-center" />
      </>
    );
  }

  const live = phase === "recording" || phase === "paused";
  const onRecordTab = tab === "record";

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-h-screen gap-0 bg-background">
      <header className="relative z-30 flex h-20 items-center px-6">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Clapperboard className="size-4" />
          </span>
          <span className="text-[15px] font-bold tracking-tight">Cutline</span>
        </div>

        {/* The nav floats in the centre of the bar rather than sitting in the
            flow, so it stays optically centred whatever the two ends hold. */}
        <TabsList className="absolute left-1/2 h-11 -translate-x-1/2 rounded-full border bg-card p-1 shadow-sm">
          {(
            [
              ["create", "Create"],
              ["record", "Record"],
              ["library", "Library"],
              ["edit", "Edit"],
              ["studio", "Studio"],
            ] as const
          ).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="rounded-full px-5 text-sm font-semibold data-[state=active]:bg-secondary data-[state=active]:shadow-none"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={toggle}
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            className="grid size-9 place-items-center rounded-full border bg-card text-muted-foreground transition-colors hover:text-foreground"
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          {live && (
            <span className="font-mono text-sm font-medium tabular-nums">
              {formatDuration(elapsed)}
            </span>
          )}
          {onRecordTab && (
            <button
              disabled={!controls?.canStart && !live}
              onClick={() => (live ? controls?.stop() : controls?.start())}
              className={cn(
                "flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition-colors",
                live
                  ? "bg-record text-white hover:brightness-105"
                  : controls?.canStart
                    ? "bg-record text-white hover:brightness-105"
                    : "cursor-not-allowed bg-muted text-muted-foreground",
              )}
            >
              {live ? (
                <>
                  <Square className="size-3 fill-current" />
                  Stop
                </>
              ) : (
                <>
                  <Circle className="size-3 fill-current" />
                  Record
                </>
              )}
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 pb-16">
        <TabsContent value="create" className="mt-0">
          <Suspense fallback={<Loading label="Loading…" />}>
            <Create
              onRecord={() => setTab("record")}
              onStart={(project, asked) => {
                setRequest(asked);
                setEditing(project);
              }}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="record" className="mt-0">
          <Studio
            onPhaseChange={setPhase}
            onElapsed={setElapsed}
            onControls={handleControls}
            onFinished={handleFinished}
          />
        </TabsContent>
        <TabsContent value="library" className="mt-6">
          <Library reloadKey={reloadKey} onEdit={() => setTab("edit")} />
        </TabsContent>
        <TabsContent value="edit" className="mt-6">
          <Suspense fallback={<Loading label="Loading projects…" />}>
            <Projects onOpen={setEditing} />
          </Suspense>
        </TabsContent>
        <TabsContent value="studio" className="mt-2">
          <Suspense fallback={<Loading label="Loading the studio…" />}>
            <WorkspaceStudio />
          </Suspense>
        </TabsContent>
      </main>

      <Toaster position="bottom-center" />
    </Tabs>
  );
}
