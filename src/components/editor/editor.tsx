import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Captions,
  Bot,
  Film,
  Gauge,
  History,
  Link2Off,
  Lock,
  Redo2,
  Save,
  Scissors,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AgentBridge } from "@/editor/agent-bridge";
import { runAutoCaptions, type AutoCaptionOptions } from "@/components/editor/auto-captions";
import { BriefPanel } from "@/components/editor/brief-panel";
import { AssetUrls } from "@/editor/media";
import {
  apply,
  findClip,
  jumpTo,
  linkSize,
  mediaClip,
  newHistory,
  redo,
  shapeClip,
  textClip,
  undo,
  type Action,
  type History as EditHistory,
} from "@/editor/project";
import { saveProject, writeRecovery } from "@/editor/persistence";
import { useProjectLock } from "@/hooks/use-project-lock";
import type { ClipRef, Project } from "@/editor/types";
import type { PlaybackEngine } from "@/editor/playback";
import { MediaPool } from "@/components/editor/media-pool";
import { Monitor } from "@/components/editor/monitor";
import { Timeline, type Tool } from "@/components/editor/timeline";
import { Inspector } from "@/components/editor/inspector";
import { CaptionsPanel } from "@/components/editor/captions-panel";
import { ExportDialog } from "@/components/editor/export-dialog";
import { Scope, type ScopeKind } from "@/components/editor/scopes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** How long the user has to stop editing before a save fires. */
const AUTOSAVE_IDLE_MS = 1500;
/** Crash copies are cheap and go to localStorage; this can be frequent. */
const RECOVERY_INTERVAL_MS = 5000;

export function Editor({
  initial,
  onClose,
  onProjectChange,
}: {
  initial: Project;
  onClose: () => void;
  /** Lets the error boundary above snapshot the live document if a render throws. */
  onProjectChange?: (project: Project) => void;
}) {
  const [history, setHistory] = useState<EditHistory>(() => newHistory(initial));
  // The agent bridge applies an edit and needs the result at once, so the
  // latest history lives in a ref that every update goes through and React
  // state mirrors it. Functional setState alone would leave the bridge reading
  // a history one render stale, and an agent edit racing a user edit could
  // drop one of them.
  const historyRef = useRef(history);
  const update = useCallback((fn: (h: EditHistory) => EditHistory) => {
    const next = fn(historyRef.current);
    historyRef.current = next;
    setHistory(next);
    return next;
  }, []);
  const [selected, setSelected] = useState<ClipRef | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [scope, setScope] = useState<ScopeKind>("histogram");
  const [rightTab, setRightTab] = useState("inspector");
  const [leftTab, setLeftTab] = useState("media");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("saved");
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [scopeVersion, setScopeVersion] = useState(0);

  const engineRef = useRef<PlaybackEngine | null>(null);
  const urls = useMemo(() => new AssetUrls(), []);
  const project = history.present;
  const { isPrimary, takeOver } = useProjectLock(initial.id);
  // Two locks, two reaches: the BroadcastChannel covers this browser's tabs,
  // the server covers every other browser. Both must agree before this saves.
  const [serverHold, setServerHold] = useState({ holder: true, editors: 1 });
  const canWrite = isPrimary && serverHold.holder;
  const bridgeRef = useRef<AgentBridge | null>(null);
  // The boundary needs the live project at the instant of a crash, and a ref is
  // the only thing that survives a render that threw.
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    onProjectChange?.(project);
  }, [project, onProjectChange]);

  useEffect(() => () => urls.dispose(), [urls]);

  /**
   * The editor forces the dark palette for as long as it is open.
   *
   * A bright surround shifts how you read exposure and colour, which is why
   * every grading suite is dark; and the stamp goes on the document element
   * rather than the editor's own root because Radix renders dialogs, menus and
   * popovers into `document.body`, outside this subtree — a scoped stamp would
   * leave every one of them light on a dark app.
   */
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = "dark";
    return () => {
      if (previous) root.dataset.theme = previous;
      else delete root.dataset.theme;
    };
  }, []);

  const dispatch = useCallback(
    (action: Action, coalesce = false) => {
      update((prev) => apply(prev, action, coalesce));
    },
    [update],
  );

  // One way to caption an asset, whichever surface asked: a clip's menu, the
  // media pool, or the Captions panel. It reads the live project when the
  // transcript arrives, and opens the panel when there is nothing to transcribe with.
  const autoCaption = useCallback(
    (assetId: string, options?: AutoCaptionOptions) =>
      runAutoCaptions({
        assetId,
        getProject: () => historyRef.current.present,
        dispatch,
        onNeedsSetup: () => setLeftTab("captions"),
        ...(options ? { options } : {}),
      }),
    [dispatch],
  );

  /* ---------------------------------------------------------------- agent */

  const timeRef = useRef(time);
  timeRef.current = time;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [agentTool, setAgentTool] = useState<string | null>(null);

  // Only the tab that saves takes agent edits — the same rule as autosave, for
  // the same reason: two tabs applying them would fork the project.
  useEffect(() => {
    if (!isPrimary) return;
    let fade: number | undefined;
    const bridge = new AgentBridge(
      {
        history: () => historyRef.current,
        update,
        playhead: () => timeRef.current,
        selection: () => selectedRef.current,
        // Held briefly after each call, so a burst of edits reads as one
        // stretch of activity instead of a flickering badge.
        onActivity: (tool) => {
          window.clearTimeout(fade);
          if (tool) setAgentTool(tool);
          else fade = window.setTimeout(() => setAgentTool(null), 2500);
        },
        onLock: (holder, editors) => setServerHold({ holder, editors }),
      },
      { id: initial.id, name: initial.name },
    );
    bridge.start();
    bridgeRef.current = bridge;
    return () => {
      window.clearTimeout(fade);
      bridge.stop();
      bridgeRef.current = null;
      setServerHold({ holder: true, editors: 1 });
    };
  }, [isPrimary, initial.id, initial.name, update]);

  /* ------------------------------------------------------------- saving */

  // Autosave waits for a pause rather than saving on every keystroke: writing a
  // whole project per slider tick would spend more time in OPFS than rendering.
  useEffect(() => {
    // A second tab on the same project does not write. Letting it autosave
    // would mean both tabs overwriting each other on every keystroke, with the
    // loser never finding out.
    if (!canWrite) return;
    setSaving("idle");
    const timer = window.setTimeout(() => {
      setSaving("saving");
      void saveProject(project)
        .then(() => setSaving("saved"))
        .catch((err: unknown) => {
          setSaving("idle");
          // One toast id, so a server that is down produces one message that
          // updates rather than a new one every autosave.
          toast.error(err instanceof Error ? err.message : "Could not save the project.", {
            id: "autosave",
          });
        });
    }, AUTOSAVE_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [project, canWrite]);

  useEffect(() => {
    if (!canWrite) return;
    const timer = window.setInterval(() => writeRecovery(project), RECOVERY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [project, canWrite]);

  // Scopes cannot observe canvas writes, so they are nudged on a slow interval
  // rather than every frame — reading pixels back is the expensive half.
  useEffect(() => {
    if (rightTab !== "scopes") return;
    const timer = window.setInterval(() => setScopeVersion((v) => v + 1), 250);
    return () => window.clearInterval(timer);
  }, [rightTab]);

  /* ------------------------------------------------------------ commands */

  const doUndo = useCallback(() => update((h) => undo(h)), [update]);
  const doRedo = useCallback(() => update((h) => redo(h)), [update]);

  const firstVideoTrack = project.tracks.find((t) => t.kind === "video") ?? project.tracks[0];

  const splitAtPlayhead = useCallback(() => {
    // Split whatever is selected, or everything under the playhead if nothing
    // is — which is what a razor key does in every editor worth copying.
    const targets: ClipRef[] = selected
      ? [selected]
      : project.tracks.flatMap((track) =>
          track.locked
            ? []
            : track.clips
                .filter((c) => time > c.start && time < c.start + c.duration)
                .map((c) => ({ trackId: track.id, clipId: c.id })),
        );
    targets.forEach((ref, i) => dispatch({ type: "splitClip", ref, time }, i > 0));
  }, [project, selected, time, dispatch]);

  const deleteSelected = useCallback(
    (ripple = false) => {
      if (!selected) return;
      dispatch(ripple ? { type: "rippleDelete", ref: selected } : { type: "deleteClip", ref: selected });
      setSelected(null);
    },
    [selected, dispatch],
  );

  const insertAsset = useCallback(
    (assetId: string, trackId?: string, start?: number) => {
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) return;
      const wantAudio = !asset.hasVideo;
      const track =
        (trackId ? project.tracks.find((t) => t.id === trackId) : undefined) ??
        project.tracks.find((t) => t.kind === (wantAudio ? "audio" : "video")) ??
        firstVideoTrack;
      if (!track) return;
      const at = start ?? time;
      dispatch({ type: "addClip", trackId: track.id, clip: mediaClip(asset, at) });
    },
    [project, time, dispatch, firstVideoTrack],
  );

  const addLayer = useCallback(
    (kind: "text" | "shape") => {
      const track = firstVideoTrack;
      if (!track) return;
      dispatch({
        type: "addClip",
        trackId: track.id,
        clip: kind === "text" ? textClip(time) : shapeClip(time),
      });
    },
    [firstVideoTrack, time, dispatch],
  );

  /**
   * Keyboard navigation of the timeline.
   *
   * Selecting and moving clips was pointer-only, which is both an accessibility
   * failure and a ceiling on how fast anyone can work. Alt is the modifier
   * because the bare arrows already step frames, and losing that would be a
   * worse trade.
   */
  const moveSelection = useCallback(
    (direction: "prev" | "next" | "up" | "down") => {
      const tracks = project.tracks;
      if (tracks.length === 0) return;

      if (!selected) {
        // Nothing selected yet: take whatever sits under the playhead, or the
        // first clip on the timeline if the playhead is over a gap.
        for (const track of tracks) {
          const under =
            track.clips.find((c) => time >= c.start && time < c.start + c.duration) ??
            track.clips[0];
          if (under) {
            setSelected({ trackId: track.id, clipId: under.id });
            return;
          }
        }
        return;
      }

      const trackIndex = tracks.findIndex((t) => t.id === selected.trackId);
      const track = tracks[trackIndex];
      if (!track) return;

      if (direction === "prev" || direction === "next") {
        const index = track.clips.findIndex((c) => c.id === selected.clipId);
        const next = track.clips[index + (direction === "next" ? 1 : -1)];
        if (next) setSelected({ trackId: track.id, clipId: next.id });
        return;
      }

      // Up and down keep the playhead position and look for whatever overlaps
      // it on the neighbouring track, so the selection follows the eye rather
      // than an index.
      const current = track.clips.find((c) => c.id === selected.clipId);
      const at = current ? current.start : time;
      const step = direction === "up" ? 1 : -1;
      for (let i = trackIndex + step; i >= 0 && i < tracks.length; i += step) {
        const candidate = tracks[i];
        if (!candidate || candidate.clips.length === 0) continue;
        const overlapping =
          candidate.clips.find((c) => at >= c.start && at < c.start + c.duration) ??
          candidate.clips.reduce((best, c) =>
            Math.abs(c.start - at) < Math.abs(best.start - at) ? c : best,
          );
        setSelected({ trackId: candidate.id, clipId: overlapping.id });
        return;
      }
    },
    [project, selected, time],
  );

  const nudgeSelected = useCallback(
    (frames: number) => {
      const clip = findClip(project, selected);
      if (!selected || !clip) return;
      dispatch({
        type: "moveClip",
        ref: selected,
        start: Math.max(0, clip.start + frames / project.frameRate),
      });
    },
    [project, selected, dispatch],
  );

  /* ----------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal a key from a field the user is typing in.
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (mod) {
        switch (e.key.toLowerCase()) {
          case "z":
            e.preventDefault();
            if (e.shiftKey) doRedo();
            else doUndo();
            return;
          case "s":
            e.preventDefault();
            void saveProject(project).then(
              () => toast.success("Project saved"),
              (err: unknown) =>
                toast.error(err instanceof Error ? err.message : "Could not save the project.", {
                  id: "save",
                }),
            );
            return;
          case "d":
            e.preventDefault();
            if (selected) dispatch({ type: "duplicateClip", ref: selected });
            return;
          default:
            return;
        }
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          engineRef.current?.toggle();
          break;
        case "j":
        case "J":
          e.preventDefault();
          engineRef.current?.shuttle(-1);
          break;
        case "k":
        case "K":
          e.preventDefault();
          engineRef.current?.pause();
          break;
        case "l":
        case "L":
          e.preventDefault();
          engineRef.current?.shuttle(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.altKey) moveSelection("prev");
          else engineRef.current?.step(e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.altKey) moveSelection("next");
          else engineRef.current?.step(e.shiftKey ? 10 : 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveSelection("up");
          break;
        case "ArrowDown":
          e.preventDefault();
          moveSelection("down");
          break;
        case ",":
          e.preventDefault();
          nudgeSelected(e.shiftKey ? -10 : -1);
          break;
        case ".":
          e.preventDefault();
          nudgeSelected(e.shiftKey ? 10 : 1);
          break;
        case "Escape":
          setSelected(null);
          break;
        case "Home":
          e.preventDefault();
          engineRef.current?.seek(0);
          break;
        case "s":
        case "S":
          e.preventDefault();
          splitAtPlayhead();
          break;
        case "i":
        case "I":
          dispatch({ type: "setProject", patch: { inPoint: time } });
          break;
        case "o":
        case "O":
          dispatch({ type: "setProject", patch: { outPoint: time } });
          break;
        case "m":
        case "M":
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
          });
          break;
        case "v":
        case "V":
          setTool("select");
          break;
        case "c":
        case "C":
          setTool("razor");
          break;
        case "y":
        case "Y":
          setTool("slip");
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          deleteSelected(e.shiftKey);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    doUndo,
    doRedo,
    splitAtPlayhead,
    deleteSelected,
    moveSelection,
    nudgeSelected,
    dispatch,
    time,
    project,
    selected,
  ]);

  const selectedClip = findClip(project, selected);
  const selectedIsLinked = Boolean(selectedClip && linkSize(project, selectedClip) > 1);
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const allHistory = [...history.past, { project, label: history.label }, ...history.future];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* ------------------------------------------------------- menu bar */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Film className="size-3.5" />
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">File</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={() => void saveProject(project).then(
              () => toast.success("Project saved"),
              (err: unknown) =>
                toast.error(err instanceof Error ? err.message : "Could not save the project.", {
                  id: "save",
                }),
            )}>
              Save<DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onClose}>Close project</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">Edit</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem disabled={!canUndo} onClick={doUndo}>
              Undo<DropdownMenuShortcut>⌘Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canRedo} onClick={doRedo}>
              Redo<DropdownMenuShortcut>⇧⌘Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={splitAtPlayhead}>
              Split at playhead<DropdownMenuShortcut>S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!selected} onClick={() => selected && dispatch({ type: "duplicateClip", ref: selected })}>
              Duplicate<DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!selected} onClick={() => deleteSelected(false)}>
              Delete<DropdownMenuShortcut>⌫</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!selected} onClick={() => deleteSelected(true)}>
              Ripple delete<DropdownMenuShortcut>⇧⌫</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!selectedIsLinked}
              onClick={() => selected && dispatch({ type: "detachAudio", ref: selected })}
            >
              <Link2Off className="size-3.5" />
              Detach audio
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!selectedIsLinked}
              onClick={() => selected && dispatch({ type: "unlinkClip", ref: selected })}
            >
              Unlink whole take
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">Insert</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => addLayer("text")}>
              <Type className="size-3.5" />Text layer
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addLayer("shape")}>
              <Square className="size-3.5" />Shape layer
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => dispatch({ type: "addTrack", kind: "video" })}>Video track</DropdownMenuItem>
            <DropdownMenuItem onClick={() => dispatch({ type: "addTrack", kind: "audio" })}>Audio track</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Input
          value={project.name}
          onChange={(e) => dispatch({ type: "setProject", patch: { name: e.target.value } })}
          className="ml-2 h-8 w-56 rounded-lg text-xs font-medium"
        />

        {canWrite ? (
          <span className="ml-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Save className={cn("size-3", saving === "saving" && "animate-pulse text-primary")} />
            {saving === "saved" ? "Saved" : saving === "saving" ? "Saving…" : "Unsaved"}
          </span>
        ) : (
          <button
            onClick={() => {
              if (!isPrimary) takeOver();
              if (!serverHold.holder) bridgeRef.current?.takeover();
            }}
            title={
              isPrimary
                ? "Another browser has this project open and is saving it. Click to make this one the editor that saves."
                : "Another tab has this project open. Click to make this tab the one that saves."
            }
            className="ml-1 flex items-center gap-1 rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-500 hover:bg-amber-400/25"
          >
            <Lock className="size-3" />
            Open elsewhere · not saving
          </button>
        )}

        {agentTool && (
          <span
            title="An agent is editing this project through MCP. Every change is in History and can be undone."
            className="ml-1 flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary"
          >
            <Bot className="size-3 animate-pulse" />
            Agent · {agentTool.replaceAll("_", " ")}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" disabled={!canUndo} onClick={doUndo} title="Undo (⌘Z)">
            <Undo2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" disabled={!canRedo} onClick={doRedo} title="Redo (⇧⌘Z)">
            <Redo2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={splitAtPlayhead} title="Split (S)">
            <Scissors className="size-3.5" />
          </Button>
          <ExportDialog project={project} />
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose} title="Close editor">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* --------------------------------------------------------- panels */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="62" minSize="30">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="19" minSize="12" className="border-r">
              <Tabs value={leftTab} onValueChange={setLeftTab} className="flex h-full flex-col gap-0">
                <TabsList className="mx-2 mt-2 grid h-7 grid-cols-3">
                  <TabsTrigger value="media" className="text-[10px]">Media</TabsTrigger>
                  <TabsTrigger value="captions" className="text-[10px]">
                    <Captions className="size-3" />Captions
                  </TabsTrigger>
                  <TabsTrigger value="brief" className="text-[10px]">Brief</TabsTrigger>
                </TabsList>
                <TabsContent value="media" className="mt-2 min-h-0 flex-1">
                  <MediaPool
                    project={project}
                    dispatch={dispatch}
                    selectedAssetId={selectedAsset}
                    onSelectAsset={setSelectedAsset}
                    onInsert={(asset) => insertAsset(asset.id)}
                    onAutoCaption={(id, options) => void autoCaption(id, options)}
                  />
                </TabsContent>
                <TabsContent value="captions" className="mt-2 min-h-0 flex-1">
                  <CaptionsPanel
                    project={project}
                    time={time}
                    dispatch={dispatch}
                    onSeek={(t) => engineRef.current?.seek(t)}
                    onAutoCaption={autoCaption}
                  />
                </TabsContent>
                <TabsContent value="brief" className="mt-2 min-h-0 flex-1">
                  <BriefPanel project={project} dispatch={dispatch} />
                </TabsContent>
              </Tabs>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize="56" minSize="30">
              <Monitor
                project={project}
                urls={urls}
                dispatch={dispatch}
                selected={selected}
                onSelect={setSelected}
                onEngine={(engine) => {
                  engineRef.current = engine;
                }}
                onTime={setTime}
                onCanvas={setCanvas}
              />
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize="25" minSize="16" className="border-l">
              <Tabs value={rightTab} onValueChange={setRightTab} className="flex h-full flex-col gap-0">
                <TabsList className="mx-2 mt-2 grid h-7 grid-cols-3">
                  <TabsTrigger value="inspector" className="text-[10px]">Inspector</TabsTrigger>
                  <TabsTrigger value="scopes" className="text-[10px]">
                    <Gauge className="size-3" />Scopes
                  </TabsTrigger>
                  <TabsTrigger value="history" className="text-[10px]">
                    <History className="size-3" />History
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="inspector" className="mt-2 min-h-0 flex-1">
                  <Inspector project={project} selected={selected} time={time} dispatch={dispatch} />
                </TabsContent>

                <TabsContent value="scopes" className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  <Select value={scope} onValueChange={(v) => setScope(v as ScopeKind)}>
                    <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="histogram">Histogram</SelectItem>
                      <SelectItem value="waveform">Luma waveform</SelectItem>
                      <SelectItem value="parade">RGB parade</SelectItem>
                      <SelectItem value="vectorscope">Vectorscope</SelectItem>
                    </SelectContent>
                  </Select>
                  <Scope source={canvas} kind={scope} version={scopeVersion} />
                  <p className="text-[10px] text-muted-foreground">
                    Measured from the program monitor, so it reflects every effect and grade
                    exactly as they will be exported.
                  </p>
                </TabsContent>

                <TabsContent value="history" className="mt-2 min-h-0 flex-1 overflow-y-auto p-1.5">
                  {allHistory.map((entry, i) => (
                    <button
                      key={i}
                      onClick={() => update((h) => jumpTo(h, i))}
                      className={cn(
                        "block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:bg-accent",
                        i === history.past.length && "bg-accent font-medium",
                        i > history.past.length && "text-muted-foreground",
                      )}
                    >
                      {entry.label}
                    </button>
                  ))}
                </TabsContent>
              </Tabs>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="38" minSize="15">
          <Timeline
            project={project}
            time={time}
            selected={selected}
            tool={tool}
            onTool={setTool}
            onSelect={setSelected}
            onSeek={(t) => engineRef.current?.seek(t)}
            dispatch={dispatch}
            onDropAsset={(assetId, trackId, start) => insertAsset(assetId, trackId, start)}
            onOpenCaptions={() => setLeftTab("captions")}
            onAutoCaption={(id, options) => void autoCaption(id, options)}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

export function findSelectedClip(project: Project, ref: ClipRef | null) {
  return findClip(project, ref);
}
