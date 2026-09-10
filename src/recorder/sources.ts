/**
 * Acquiring live streams. Each function returns one ArmedSource per *file we
 * intend to write*, which is why a screen share can return two: the display
 * video and, if the user shared audio, the system audio as its own source.
 */

import type { ArmedSource, SourceKind } from "./types";

export function newId(): string {
  return crypto.randomUUID();
}

function arm(kind: SourceKind, label: string, track: MediaStreamTrack): ArmedSource {
  const source: ArmedSource = {
    id: newId(),
    kind,
    label,
    stream: new MediaStream([track]),
    ended: false,
  };
  return source;
}

/** Subscribe to the OS or browser revoking a source (the "Stop sharing" bar). */
export function watchForEnd(source: ArmedSource, onEnd: () => void): () => void {
  const tracks = source.stream.getTracks();
  const handler = () => {
    source.ended = true;
    onEnd();
  };
  tracks.forEach((t) => t.addEventListener("ended", handler));
  return () => tracks.forEach((t) => t.removeEventListener("ended", handler));
}

export function stopSource(source: ArmedSource): void {
  source.stream.getTracks().forEach((t) => t.stop());
  source.ended = true;
}

/* ------------------------------------------------------------------- screen */

export interface ScreenOptions {
  frameRate: number;
  /** Ask for system audio alongside the picture. Availability is OS-dependent. */
  withSystemAudio: boolean;
}

function describeSurface(track: MediaStreamTrack): string {
  const surface = (track.getSettings() as { displaySurface?: string }).displaySurface;
  if (surface === "monitor") return "Screen";
  if (surface === "window") return "Window";
  if (surface === "browser") return "Browser tab";
  return "Screen";
}

export async function acquireScreen(options: ScreenOptions): Promise<ArmedSource[]> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: options.frameRate } },
    // Capture hints must not be processed: echo cancellation on system audio
    // would chew holes in music and in anything the microphone also hears.
    audio: options.withSystemAudio
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false,
    // Chrome-only hints. Excluding our own tab stops the recorder from being
    // offered as a capture target, which is otherwise an easy infinite mirror.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: options.withSystemAudio ? "include" : "exclude",
  } as DisplayMediaStreamOptions);

  const out: ArmedSource[] = [];
  const video = stream.getVideoTracks()[0];
  if (video) out.push(arm("screen", describeSurface(video), video));
  const audio = stream.getAudioTracks()[0];
  if (audio) out.push(arm("system-audio", "System audio", audio));
  return out;
}

/* ------------------------------------------------------------------- camera */

export interface CameraOptions {
  deviceId: string | null;
  width: number;
  height: number;
  frameRate: number;
}

export async function acquireCamera(options: CameraOptions): Promise<ArmedSource[]> {
  // Video only. The microphone is acquired separately so the two land in
  // separate files and can be re-timed, replaced or muted independently.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      width: { ideal: options.width },
      height: { ideal: options.height },
      frameRate: { ideal: options.frameRate },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("Camera returned no video track.");
  return [arm("camera", track.label || "Camera", track)];
}

/* --------------------------------------------------------------- microphone */

export interface MicrophoneOptions {
  deviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  /**
   * Off by default. Automatic gain rides the level up and down during a take,
   * and that pumping cannot be undone in the edit — whereas a quiet recording
   * can simply be turned up.
   */
  autoGainControl: boolean;
}

export async function acquireMicrophone(options: MicrophoneOptions): Promise<ArmedSource[]> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      echoCancellation: options.echoCancellation,
      noiseSuppression: options.noiseSuppression,
      autoGainControl: options.autoGainControl,
    },
    video: false,
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("Microphone returned no audio track.");
  return [arm("microphone", track.label || "Microphone", track)];
}

/* --------------------------------------------------------------- diagnostics */

/** Turn a getUserMedia/getDisplayMedia rejection into something a human can act on. */
export function explainMediaError(err: unknown, kind: SourceKind): string {
  const name = err instanceof DOMException ? err.name : "";
  const thing =
    kind === "screen" || kind === "system-audio"
      ? "Screen sharing"
      : kind === "camera"
        ? "The camera"
        : "The microphone";
  switch (name) {
    case "NotAllowedError":
      return `${thing} was blocked. Allow it in the browser's site settings, then try again.`;
    case "NotFoundError":
      return `${thing} was not found on this machine.`;
    case "NotReadableError":
      return `${thing} is in use by another app. Close that app and try again.`;
    case "OverconstrainedError":
      return `${thing} does not support the requested resolution or frame rate.`;
    case "AbortError":
      return `${thing} request was dismissed.`;
    default:
      return err instanceof Error ? err.message : `${thing} could not be started.`;
  }
}
