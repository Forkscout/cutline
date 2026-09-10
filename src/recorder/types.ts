/**
 * One recording session produces several independent files — screen, camera,
 * microphone — never a pre-mixed one. That is the whole point: the editor gets
 * to decide later how they compose, and a decision made at record time is a
 * decision that cannot be taken back.
 *
 * What makes the separate files usable together is `offsetMs`. Every track
 * measures its start against one clock owned by the session, so the editor can
 * lay them on a timeline without asking the user to nudge anything into place.
 */

/**
 * Four, not three: a screen share may carry system audio, and folding that
 * into the screen video file would be exactly the kind of un-take-back-able
 * decision this recorder exists to avoid. It gets its own file.
 */
export type SourceKind = "screen" | "camera" | "microphone" | "system-audio";

/** A span of wall-clock time the recorder was paused; absent from the file. */
export interface PauseSpan {
  /** Offset into the session clock where the pause began, ms. */
  at: number;
  /** How long it lasted, ms. */
  ms: number;
}

export interface TrackMeta {
  id: string;
  kind: SourceKind;
  /** Human name of the device or display this came from. */
  label: string;
  mimeType: string;
  /** File name inside the session's OPFS directory. */
  fileName: string;
  bytes: number;

  /**
   * Milliseconds between the session clock's origin and this track's first
   * frame. Recorders are started in one synchronous block, so in practice this
   * is under a few ms — but it is measured, not assumed.
   */
  offsetMs: number;
  /**
   * Recorded media duration, excluding paused time. This is our own
   * measurement: MediaRecorder cannot rewrite a WebM header after the fact, so
   * the container's own duration field is unreliable and must not be trusted.
   */
  durationMs: number;
  pauses: PauseSpan[];

  /** Video-only, from the track's actual settings rather than what we asked for. */
  width?: number;
  height?: number;
  frameRate?: number;
  /** Audio-only. */
  sampleRate?: number;
  channelCount?: number;
}

export interface SessionMeta {
  id: string;
  name: string;
  /** Wall-clock creation time, for sorting and display. */
  createdAt: number;
  /** Total session length including paused time, ms. */
  durationMs: number;
  tracks: TrackMeta[];
}

export type RecorderPhase = "idle" | "arming" | "recording" | "paused" | "finalizing";

/** A live source that has been granted and is previewing, but may not be recording yet. */
export interface ArmedSource {
  id: string;
  kind: SourceKind;
  label: string;
  stream: MediaStream;
  /** Set when the user revokes the source from the OS (e.g. "Stop sharing"). */
  ended: boolean;
}
