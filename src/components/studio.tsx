import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Pause,
  Play,
  Settings,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { ArmedSource, RecorderPhase, SessionMeta, SourceKind } from "@/recorder/types";
import {
  acquireCamera,
  acquireMicrophone,
  acquireScreen,
  explainMediaError,
  stopSource,
} from "@/recorder/sources";
import { listDevices, onDeviceChange, primePermissions } from "@/recorder/devices";
import type { DeviceLists } from "@/recorder/devices";
import { RecordingSession } from "@/recorder/session";
import { requestPersistence } from "@/recorder/storage";
import { syncLocalRecordings } from "@/lib/sync";
import { CursorCapture } from "@/lib/cursor-capture";
import { ModeArt } from "@/components/studio-art";
import { LevelMeter } from "@/components/level-meter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export type CaptureMode = "screen" | "camera" | "screen-camera" | "audio";

/** What the header's Record button needs in order to drive the recorder. */
export interface StudioControls {
  canStart: boolean;
  start: () => void;
  stop: () => void;
}

const MODES: { id: CaptureMode; title: string; blurb: string }[] = [
  { id: "screen", title: "Screen only", blurb: "Your screen, with its own audio" },
  { id: "camera", title: "Camera", blurb: "You, talking to the lens" },
  { id: "screen-camera", title: "Screen & Camera", blurb: "A demo with your face on it" },
  { id: "audio", title: "Audio", blurb: "Voice, no picture" },
];

const EMPTY_DEVICES: DeviceLists = { cameras: [], microphones: [], needsPermission: false };
/** Radix rejects an empty string as a Select value, so the default needs a name. */
const DEFAULT_DEVICE = "default-device";

/* ------------------------------------------------------------------ pieces */

function ToolButton({
  icon: Icon,
  label,
  active,
  danger,
  disabled,
  onClick,
}: {
  icon: typeof Camera;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="group flex w-20 flex-col items-center gap-1.5 disabled:opacity-40"
    >
      <span
        className={cn(
          "grid size-11 place-items-center rounded-xl border transition-colors",
          active
            ? "border-transparent bg-primary text-primary-foreground"
            : danger
              ? "border-transparent bg-record/10 text-record"
              : "bg-secondary text-foreground group-hover:bg-accent",
        )}
      >
        <Icon className="size-[18px]" />
      </span>
      <span
        className={cn(
          "text-[11px] font-semibold",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </button>
  );
}

function VideoTile({ stream, className }: { stream: MediaStream; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  // Muted is not a style choice: an unmuted preview of a screen share with
  // system audio feeds the speakers straight back into the microphone.
  return <video ref={ref} className={className} autoPlay muted playsInline />;
}

/* ------------------------------------------------------------------ studio */

export function Studio({
  onFinished,
  onPhaseChange,
  onElapsed,
  onControls,
}: {
  onFinished: (meta: SessionMeta) => void;
  onPhaseChange: (phase: RecorderPhase) => void;
  onElapsed: (ms: number) => void;
  onControls: (controls: StudioControls | null) => void;
}) {
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const [devices, setDevices] = useState<DeviceLists>(EMPTY_DEVICES);
  const [sources, setSources] = useState<ArmedSource[]>([]);
  const [phase, setPhaseState] = useState<RecorderPhase>("idle");
  const [bytes, setBytes] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const [cameraId, setCameraId] = useState(DEFAULT_DEVICE);
  const [micId, setMicId] = useState(DEFAULT_DEVICE);
  const [withSystemAudio, setWithSystemAudio] = useState(true);
  const [frameRate, setFrameRate] = useState("30");
  const [noiseSuppression, setNoiseSuppression] = useState(true);

  const sessionRef = useRef<RecordingSession | null>(null);
  const cursorRef = useRef<CursorCapture | null>(null);

  const setPhase = useCallback(
    (next: RecorderPhase) => {
      setPhaseState(next);
      onPhaseChange(next);
    },
    [onPhaseChange],
  );

  const refreshDevices = useCallback(() => {
    void listDevices().then(setDevices);
  }, []);

  useEffect(() => {
    refreshDevices();
    return onDeviceChange(refreshDevices);
  }, [refreshDevices]);

  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const timer = window.setInterval(() => onElapsed(sessionRef.current?.recordedMs() ?? 0), 200);
    return () => window.clearInterval(timer);
  }, [phase, onElapsed]);

  const live = phase === "recording" || phase === "paused";
  const has = (kind: SourceKind) => sources.some((s) => s.kind === kind);
  const screenSource = sources.find((s) => s.kind === "screen");
  const cameraSource = sources.find((s) => s.kind === "camera");
  const micSource = sources.find((s) => s.kind === "microphone");

  /* ------------------------------------------------------------ arming */

  const arm = async (next: CaptureMode) => {
    setBusy(true);
    try {
      const acquired: ArmedSource[] = [];
      if (next === "screen" || next === "screen-camera") {
        acquired.push(...(await acquireScreen({ frameRate: Number(frameRate), withSystemAudio })));
      }
      if (next === "camera" || next === "screen-camera") {
        acquired.push(
          ...(await acquireCamera({
            deviceId: cameraId === DEFAULT_DEVICE ? null : cameraId,
            width: 1920,
            height: 1080,
            frameRate: Number(frameRate),
          })),
        );
      }
      if (next !== "screen") {
        acquired.push(
          ...(await acquireMicrophone({
            deviceId: micId === DEFAULT_DEVICE ? null : micId,
            echoCancellation: true,
            noiseSuppression,
            autoGainControl: false,
          })),
        );
      }
      setSources(acquired);
      setMode(next);
      // Device labels only resolve after a grant, so a fresh list is worth it.
      refreshDevices();
    } catch (err) {
      // A dismissed picker should land back on the choice, not in a half-armed
      // state with nothing on screen.
      setSources((prev) => {
        prev.forEach(stopSource);
        return [];
      });
      toast.error(explainMediaError(err, next === "audio" ? "microphone" : "screen"));
    } finally {
      setBusy(false);
    }
  };

  const disarm = () => {
    sources.forEach(stopSource);
    setSources([]);
    setMode(null);
    setBytes({});
  };

  const toggleSource = async (kind: "camera" | "microphone") => {
    const existing = sources.find((s) => s.kind === kind);
    if (existing) {
      stopSource(existing);
      setSources((prev) => prev.filter((s) => s.id !== existing.id));
      return;
    }
    try {
      const next =
        kind === "camera"
          ? await acquireCamera({
              deviceId: cameraId === DEFAULT_DEVICE ? null : cameraId,
              width: 1920,
              height: 1080,
              frameRate: Number(frameRate),
            })
          : await acquireMicrophone({
              deviceId: micId === DEFAULT_DEVICE ? null : micId,
              echoCancellation: true,
              noiseSuppression,
              autoGainControl: false,
            });
      setSources((prev) => [...prev, ...next]);
    } catch (err) {
      toast.error(explainMediaError(err, kind));
    }
  };

  const addScreen = async () => {
    if (has("screen")) return;
    try {
      const next = await acquireScreen({ frameRate: Number(frameRate), withSystemAudio });
      setSources((prev) => [...prev, ...next]);
    } catch (err) {
      toast.error(explainMediaError(err, "screen"));
    }
  };

  /* --------------------------------------------------------- recording */

  const finish = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    setPhase("finalizing");
    try {
      const problems = session.errors();
      const meta = await session.stop();
      // A device that delivered nothing — unplugged, or muted at the OS — is
      // worth hearing about now, not when the edit comes up silent.
      const empty = meta.tracks.filter((t) => t.bytes === 0).map((t) => t.label);
      if (empty.length > 0) problems.push(`Nothing was recorded from ${empty.join(" and ")}.`);
      const cursor = cursorRef.current;
      cursorRef.current = null;
      await cursor?.stop();
      // Start moving the take to disk now; the library waits on this same
      // sync before it lists anything.
      void syncLocalRecordings().catch(() => undefined);
      setSources([]);
      setMode(null);
      setBytes({});
      onElapsed(0);
      setPhase("idle");
      if (problems.length > 0) toast.warning(problems.join(" "));
      onFinished(meta);
    } catch (err) {
      setPhase("idle");
      toast.error(err instanceof Error ? err.message : "Could not finish the recording.");
    }
  }, [onFinished, onElapsed, setPhase]);

  const handleSourceEnded = useCallback(
    (source: ArmedSource) => {
      // The browser's "Stop sharing" bar is a stop button as far as the user is
      // concerned. Honour it rather than quietly recording a dead track.
      setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, ended: true } : s)));
      if (source.kind === "screen") void finish();
    },
    [finish],
  );

  const start = useCallback(async () => {
    if (sources.length === 0) return;
    setPhase("arming");
    try {
      await requestPersistence();
      const session = await RecordingSession.prepare(sources, {
        name: `Recording ${new Date().toLocaleString()}`,
        onSourceEnded: handleSourceEnded,
        onProgress: (id, written) => setBytes((prev) => ({ ...prev, [id]: written })),
        onStorageError: (message) => toast.error(`Storage: ${message}`),
      });
      sessionRef.current = session;
      session.start();
      setPhase("recording");

      // The cursor track, sampled by the local server on the same clock.
      // Best-effort: a take never waits on it, or fails for want of it.
      const screen = sources.find((s) => s.kind === "screen")?.stream.getVideoTracks()[0];
      if (screen) {
        const settings = screen.getSettings() as { displaySurface?: string; width?: number; height?: number };
        void CursorCapture.start(session.id, session.clockOriginWall, {
          surface: settings.displaySurface,
          width: settings.width,
          height: settings.height,
        }).then((capture) => {
          if (sessionRef.current === session) cursorRef.current = capture;
          else void capture?.stop(true);
        });
      }
    } catch (err) {
      sessionRef.current = null;
      setPhase("idle");
      toast.error(err instanceof Error ? err.message : "Could not start recording.");
    }
  }, [sources, handleSourceEnded, setPhase]);

  const discard = async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    void cursorRef.current?.stop(true);
    cursorRef.current = null;
    await session.abort();
    setSources([]);
    setMode(null);
    onElapsed(0);
    setPhase("idle");
    toast("Take discarded.");
  };

  const togglePause = () => {
    const session = sessionRef.current;
    if (!session) return;
    if (phase === "recording") {
      session.pause();
      cursorRef.current?.pause();
      setPhase("paused");
    } else if (phase === "paused") {
      session.resume();
      cursorRef.current?.resume();
      setPhase("recording");
    }
  };

  /**
   * The header's Record button is driven from here, and the wiring has to be
   * identity-proof.
   *
   * `start` and `finish` are rebuilt whenever their props change, and the
   * parent re-renders every time it receives a new controls object — so an
   * effect keyed on those functions feeds itself and React gives up with
   * "maximum update depth exceeded". Everything imperative goes in refs; the
   * effect watches one boolean.
   */
  const startRef = useRef(start);
  const finishRef = useRef(finish);
  const onControlsRef = useRef(onControls);
  startRef.current = start;
  finishRef.current = finish;
  onControlsRef.current = onControls;

  const canStart = sources.length > 0 && phase === "idle";
  useEffect(() => {
    const push = onControlsRef.current;
    push({
      canStart,
      start: () => void startRef.current(),
      stop: () => void finishRef.current(),
    });
    return () => push(null);
  }, [canStart]);

  /* -------------------------------------------------------------- picker */

  if (!mode) {
    return (
      <div className="mx-auto max-w-4xl pt-6">
        <h1 className="text-center text-[42px] leading-[1.1] font-extrabold">
          What would you like to record?
        </h1>

        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {MODES.map((item) => (
            <button
              key={item.id}
              disabled={busy}
              onClick={() => void arm(item.id)}
              className="group rounded-2xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg disabled:pointer-events-none disabled:opacity-60"
            >
              <p className="pb-3 text-center text-[15px] font-bold">{item.title}</p>
              <div className="aspect-[16/10]">
                <ModeArt mode={item.id} />
              </div>
              <p className="pt-3 text-center text-xs text-muted-foreground">{item.blurb}</p>
            </button>
          ))}
        </div>

        {busy && (
          <p className="mt-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Waiting for permission…
          </p>
        )}

        <div className="mt-10 flex justify-center">
          <SettingsPopover
            devices={devices}
            cameraId={cameraId}
            micId={micId}
            frameRate={frameRate}
            withSystemAudio={withSystemAudio}
            noiseSuppression={noiseSuppression}
            locked={false}
            setCameraId={setCameraId}
            setMicId={setMicId}
            setFrameRate={setFrameRate}
            setWithSystemAudio={setWithSystemAudio}
            setNoiseSuppression={setNoiseSuppression}
            onPrime={() => void primePermissions().then(refreshDevices)}
          />
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- armed */

  const stageSource = screenSource ?? cameraSource;
  const totalBytes = Object.values(bytes).reduce((n, b) => n + b, 0);

  return (
    <div className="mx-auto flex max-w-5xl flex-col items-center pt-2">
      <div className="mb-3 flex w-full items-center">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-muted-foreground"
          disabled={live}
          onClick={disarm}
        >
          <ArrowLeft className="size-4" />
          Go back
        </Button>
        {live && totalBytes > 0 && (
          <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
            {formatBytes(totalBytes)} written
          </span>
        )}
      </div>

      <div className="relative w-full overflow-hidden rounded-2xl border bg-surface-deep">
        {stageSource ? (
          <VideoTile stream={stageSource.stream} className="aspect-video w-full object-contain" />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-6 px-16">
            <Mic className="size-10 text-primary" />
            {micSource && (
              <div className="w-full max-w-md">
                <LevelMeter stream={micSource.stream} active recording={live} tone="onDark" />
              </div>
            )}
          </div>
        )}

        {/* The camera rides over the screen exactly as it will in the edit, so
            the framing decision is made once, here, and not discovered later. */}
        {screenSource && cameraSource && (
          <div className="absolute right-4 bottom-4 w-1/5 overflow-hidden rounded-xl border-2 border-surface-deep shadow-xl">
            <VideoTile stream={cameraSource.stream} className="aspect-video w-full object-cover" />
          </div>
        )}

        {stageSource && micSource && (
          <div className="absolute right-4 bottom-4 left-4 max-w-xs">
            {!cameraSource && (
              <LevelMeter stream={micSource.stream} active recording={live} tone="onDark" />
            )}
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-1">
        <ToolButton
          icon={cameraSource ? Camera : CameraOff}
          label={cameraSource ? "Hide cam" : "Show cam"}
          active={Boolean(cameraSource)}
          onClick={() => void toggleSource("camera")}
        />
        <ToolButton
          icon={micSource ? Mic : MicOff}
          label={micSource ? "Mute mic" : "Unmute"}
          active={Boolean(micSource)}
          onClick={() => void toggleSource("microphone")}
        />
        <ToolButton
          icon={Monitor}
          label="Screen"
          active={Boolean(screenSource)}
          disabled={live || Boolean(screenSource)}
          onClick={() => void addScreen()}
        />

        <Separator orientation="vertical" className="mx-3 !h-10" />

        {live && (
          <ToolButton
            icon={phase === "paused" ? Play : Pause}
            label={phase === "paused" ? "Resume" : "Pause"}
            onClick={togglePause}
          />
        )}
        {live && <ToolButton icon={Trash2} label="Discard" danger onClick={() => void discard()} />}

        <SettingsPopover
          asTool
          devices={devices}
          cameraId={cameraId}
          micId={micId}
          frameRate={frameRate}
          withSystemAudio={withSystemAudio}
          noiseSuppression={noiseSuppression}
          locked={live}
          setCameraId={setCameraId}
          setMicId={setMicId}
          setFrameRate={setFrameRate}
          setWithSystemAudio={setWithSystemAudio}
          setNoiseSuppression={setNoiseSuppression}
          onPrime={() => void primePermissions().then(refreshDevices)}
        />
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        {sources.length} file{sources.length === 1 ? "" : "s"} · each source is recorded separately
        on a shared clock, so you can re-time or replace any of them later
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

function SettingsPopover({
  asTool,
  devices,
  cameraId,
  micId,
  frameRate,
  withSystemAudio,
  noiseSuppression,
  locked,
  setCameraId,
  setMicId,
  setFrameRate,
  setWithSystemAudio,
  setNoiseSuppression,
  onPrime,
}: {
  asTool?: boolean;
  devices: DeviceLists;
  cameraId: string;
  micId: string;
  frameRate: string;
  withSystemAudio: boolean;
  noiseSuppression: boolean;
  locked: boolean;
  setCameraId: (v: string) => void;
  setMicId: (v: string) => void;
  setFrameRate: (v: string) => void;
  setWithSystemAudio: (v: boolean) => void;
  setNoiseSuppression: (v: boolean) => void;
  onPrime: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {asTool ? (
          <button className="group flex w-20 flex-col items-center gap-1.5">
            <span className="grid size-11 place-items-center rounded-xl border bg-secondary transition-colors group-hover:bg-accent">
              <Settings className="size-[18px]" />
            </span>
            <span className="text-[11px] font-semibold text-muted-foreground">Settings</span>
          </button>
        ) : (
          <Button variant="outline" className="h-10 rounded-full px-5 text-sm font-semibold">
            <Settings className="size-4" />
            Devices & quality
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-4" align="center">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Camera</Label>
          <Select value={cameraId} onValueChange={setCameraId}>
            <SelectTrigger className="h-9 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_DEVICE}>Default camera</SelectItem>
              {devices.cameras.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Microphone</Label>
          <Select value={micId} onValueChange={setMicId}>
            <SelectTrigger className="h-9 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_DEVICE}>Default microphone</SelectItem>
              {devices.microphones.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Frame rate</Label>
          <Select value={frameRate} onValueChange={setFrameRate} disabled={locked}>
            <SelectTrigger className="h-9 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24">24 fps</SelectItem>
              <SelectItem value="30">30 fps</SelectItem>
              <SelectItem value="60">60 fps</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">System audio</Label>
          <Switch
            className="ml-auto"
            checked={withSystemAudio}
            disabled={locked}
            onCheckedChange={setWithSystemAudio}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Noise suppression</Label>
          <Switch
            className="ml-auto"
            checked={noiseSuppression}
            disabled={locked}
            onCheckedChange={setNoiseSuppression}
          />
        </div>

        {devices.needsPermission && (
          <Button variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={onPrime}>
            Show device names
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
