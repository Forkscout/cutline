/**
 * MediaRecorder support differs by browser and by build, and `isTypeSupported`
 * is the only honest way to ask. We negotiate rather than hardcode.
 *
 * VP9 leads the video list because this recorder's most common subject is a
 * screen — text and UI, where VP9's smaller blocks hold edges that VP8 smears.
 */

const VIDEO_WITH_AUDIO = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
] as const;

/**
 * A camera or screen source is video-only here — its audio is a separate file
 * by design. Declaring `,opus` on a stream that carries no audio track asks the
 * muxer for a track that never arrives, and Chrome answers by writing a WebM
 * whose audio track is present in the header and empty in the body.
 */
const VIDEO_ONLY = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
] as const;

const AUDIO_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

function firstSupported(candidates: readonly string[]): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export function pickVideoMime(): string | null {
  return firstSupported(VIDEO_WITH_AUDIO);
}

export function pickAudioMime(): string | null {
  return firstSupported(AUDIO_CANDIDATES);
}

/**
 * The only mime picker callers should use for an actual recording: it reads
 * what the stream really carries rather than what the source is nominally for.
 */
export function pickMimeForStream(stream: MediaStream): string | null {
  const hasVideo = stream.getVideoTracks().length > 0;
  const hasAudio = stream.getAudioTracks().length > 0;
  if (hasVideo) return firstSupported(hasAudio ? VIDEO_WITH_AUDIO : VIDEO_ONLY);
  return firstSupported(AUDIO_CANDIDATES);
}

/** File extension implied by a MIME type, without the dot. */
export function extensionFor(mimeType: string): string {
  if (mimeType.startsWith("video/mp4") || mimeType.startsWith("audio/mp4")) return "mp4";
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  return "webm";
}

export interface SupportReport {
  mediaRecorder: boolean;
  displayCapture: boolean;
  userMedia: boolean;
  opfs: boolean;
  videoMime: string | null;
  audioMime: string | null;
}

export function checkSupport(): SupportReport {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  return {
    mediaRecorder: typeof MediaRecorder !== "undefined",
    displayCapture: !!md && typeof md.getDisplayMedia === "function",
    userMedia: !!md && typeof md.getUserMedia === "function",
    opfs:
      typeof navigator !== "undefined" &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === "function",
    videoMime: pickVideoMime(),
    audioMime: pickAudioMime(),
  };
}

/** The list of things that are missing, phrased for a human. */
export function missingRequirements(r: SupportReport): string[] {
  const out: string[] = [];
  if (!r.mediaRecorder) out.push("MediaRecorder is unavailable in this browser.");
  if (!r.userMedia) out.push("Camera and microphone capture is unavailable — this page needs HTTPS or localhost.");
  if (!r.displayCapture) out.push("Screen capture is unavailable in this browser.");
  if (!r.opfs) out.push("Origin Private File System is unavailable, so recordings cannot be stored.");
  if (r.mediaRecorder && !r.videoMime) out.push("No supported video recording format.");
  if (r.mediaRecorder && !r.audioMime) out.push("No supported audio recording format.");
  return out;
}
