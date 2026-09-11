/**
 * Which device a track came from. On its own, with no DOM types beside it, so
 * the project document can name it without dragging `MediaStream` into code
 * the server type-checks.
 */
export type SourceKind = "screen" | "camera" | "microphone" | "system-audio";
