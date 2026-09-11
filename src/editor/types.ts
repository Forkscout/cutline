/**
 * The project document.
 *
 * Plain JSON, no class instances, no functions — which is what lets undo be a
 * stack of whole snapshots, autosave be a `JSON.stringify`, and the exporter
 * work from the same object the UI is editing.
 *
 * Positions are normalised (0..1 of the frame) rather than stored in pixels, so
 * changing the sequence resolution or exporting at another size moves nothing.
 */

// Relative, not "@/": the server imports this file too, and has no alias.
import type { SourceKind } from "../recorder/source-kind";

/* ------------------------------------------------------------------ media */

export type AssetKind = "video" | "audio" | "image";

export interface MediaAsset {
  id: string;
  /** Where the bytes live: an OPFS recording, or a file the user dropped in. */
  origin: { type: "recording"; sessionId: string; fileName: string } | { type: "file" };
  name: string;
  kind: AssetKind;
  /** Set when the asset came from a Cutline recording. */
  sourceKind?: SourceKind;
  mimeType: string;
  bytes: number;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  sampleRate?: number;
  channels?: number;
  createdAt: number;
  /** Organisation. */
  binId: string | null;
  tags: string[];
  rating: number;
  colorLabel: string | null;
  favorite: boolean;
  /**
   * A small transcode used for playback only.
   *
   * Preview decodes in real time, and a 4K screen recording will not keep up
   * on any machine that is also compositing three other layers. Export always
   * reads the original, so nothing is lost to it.
   *
   * Interpreted against the asset's own origin: a file name inside the session
   * directory for a recording, a media-store id for an imported file.
   */
  proxyName?: string;

  /** A data URL, cached so the browser does not re-decode on every render. */
  thumbnail?: string;
  /** Normalised min/max pairs per bucket, for drawing waveforms. */
  peaks?: number[];
  /** True when the underlying bytes could not be found on load. */
  offline?: boolean;
}

export interface Bin {
  id: string;
  name: string;
  parentId: string | null;
}

/* ------------------------------------------------------------- animation */

export type Easing = "linear" | "ease" | "easeIn" | "easeOut" | "hold";

export interface Keyframe {
  id: string;
  /** Dot path into the clip, e.g. "transform.scale" or "color.exposure". */
  property: string;
  /** Seconds from the clip's own start, so trimming does not shift animation. */
  time: number;
  value: number;
  easing: Easing;
}

/* ------------------------------------------------------------- appearance */

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export type LayerShape = "rect" | "circle";

export interface Transform {
  /** Where the anchor point lands in the frame, 0..1. */
  x: number;
  y: number;
  /** 1 means "fit inside the frame". */
  scale: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** The point the layer scales and rotates about, 0..1 within the layer. */
  anchorX: number;
  anchorY: number;
  opacity: number;
  flipH: boolean;
  flipV: boolean;
  /** Fraction taken off each edge of the source, 0..0.45. */
  crop: { top: number; right: number; bottom: number; left: number };
  /** Corner rounding in pixels at a 1080-tall reference; scales with the frame. */
  radius: number;
  shape: LayerShape;
  shadow: number;
  blendMode: BlendMode;
}

export interface ColorGrade {
  exposure: number;
  brightness: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  hue: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  sharpen: number;
  fade: number;
}

export type EffectType =
  | "blur"
  | "gaussianBlur"
  | "sharpen"
  | "glow"
  | "grain"
  | "vignette"
  | "pixelate"
  | "posterize"
  | "grayscale"
  | "sepia"
  | "invert"
  | "tint"
  | "chromaticAberration"
  | "scanlines";

export interface EffectInstance {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
}

export type MaskShape = "none" | "rect" | "ellipse";

export interface Mask {
  shape: MaskShape;
  /** Normalised to the layer's own box. */
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
  rotation: number;
  invert: boolean;
}

export interface ChromaKey {
  enabled: boolean;
  color: string;
  similarity: number;
  smoothness: number;
  spill: number;
}

/* ------------------------------------------------------------------- text */

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  align: "left" | "center" | "right";
  letterSpacing: number;
  lineHeight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  shadowBlur: number;
  shadowColor: string;
  background: string | null;
  backgroundPadding: number;
}

export type TextAnimation =
  | "none"
  | "fade"
  | "slideUp"
  | "slideLeft"
  | "typewriter"
  | "pop"
  | "scale";

/* ------------------------------------------------------------------ shape */

export type ShapeKind = "rectangle" | "ellipse" | "line" | "triangle" | "star" | "arrow";

export interface ShapeStyle {
  kind: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Star and polygon only. */
  points: number;
  cornerRadius: number;
}

/* ------------------------------------------------------------ transitions */

export type TransitionType =
  | "none"
  | "dissolve"
  | "fadeToBlack"
  | "fadeToWhite"
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "pushLeft"
  | "pushRight"
  | "slideUp"
  | "slideDown"
  | "zoom"
  | "blur";

export interface Transition {
  type: TransitionType;
  duration: number;
  easing: Easing;
}

/* ------------------------------------------------------------------ clips */

export type ClipKind = "media" | "text" | "shape" | "adjustment" | "caption";

export interface Clip {
  id: string;
  kind: ClipKind;
  /** Media clips only. */
  assetId?: string;
  name: string;

  start: number;
  inPoint: number;
  duration: number;

  /** 1 is normal; the source is consumed `speed` times faster. */
  speed: number;
  reversed: boolean;
  /** Holds a single source frame for the clip's whole length. */
  freeze: boolean;

  volume: number;
  pan: number;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;

  transform: Transform;
  color: ColorGrade;
  effects: EffectInstance[];
  mask: Mask;
  chroma: ChromaKey;
  keyframes: Keyframe[];

  transitionIn: Transition;
  transitionOut: Transition;

  text?: TextStyle;
  textAnimation?: TextAnimation;
  shape?: ShapeStyle;

  /**
   * Clips captured in one take share a link id and are edited as a unit —
   * moved, trimmed, split and deleted together.
   *
   * Without this, a face on one track and the voice on another drift apart the
   * first time either is trimmed, and nothing in the interface says so until
   * the lips stop matching the words. Breaking the link is a deliberate act
   * ("Detach audio"), which is the right way round.
   */
  linkId: string | null;

  enabled: boolean;
  label: string | null;
}

/* ----------------------------------------------------------------- tracks */

export type TrackKind = "video" | "audio";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  muted: boolean;
  solo: boolean;
  hidden: boolean;
  locked: boolean;
  height: number;
  color: string | null;
}

/* --------------------------------------------------------------- markers */

export interface Marker {
  id: string;
  time: number;
  duration: number;
  name: string;
  note: string;
  color: string;
}

/* -------------------------------------------------------------- sequence */

export type Background =
  | { type: "solid"; color: string }
  | { type: "gradient"; from: string; to: string; angle: number }
  | { type: "transparent" };

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  background: string | null;
  strokeColor: string;
  strokeWidth: number;
  /** 0..1 from the top of the frame. */
  y: number;
  align: "left" | "center" | "right";
}

export interface Guides {
  grid: boolean;
  thirds: boolean;
  center: boolean;
  titleSafe: boolean;
  actionSafe: boolean;
  snapToGuides: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;

  width: number;
  height: number;
  frameRate: number;
  background: Background;
  /** Inset applied to the bottom-most video layer, as a fraction of the frame. */
  padding: number;

  tracks: Track[];
  assets: MediaAsset[];
  bins: Bin[];
  markers: Marker[];

  captions: CaptionCue[];
  captionStyle: CaptionStyle;
  captionsEnabled: boolean;

  guides: Guides;
  /** Playback range, when the user has set one. */
  inPoint: number | null;
  outPoint: number | null;
}

/* ---------------------------------------------------------------- helpers */

export const DEFAULT_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  opacity: 1,
  flipH: false,
  flipV: false,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  radius: 0,
  shape: "rect",
  shadow: 0,
  blendMode: "normal",
};

/** Every field is the identity value, so a fresh grade is a guaranteed no-op. */
export const DEFAULT_COLOR: ColorGrade = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  sharpen: 0,
  fade: 0,
};

export const DEFAULT_MASK: Mask = {
  shape: "none",
  x: 0.5,
  y: 0.5,
  width: 0.8,
  height: 0.8,
  feather: 0,
  rotation: 0,
  invert: false,
};

export const DEFAULT_CHROMA: ChromaKey = {
  enabled: false,
  color: "#00b140",
  similarity: 0.4,
  smoothness: 0.1,
  spill: 0.3,
};

export const NO_TRANSITION: Transition = { type: "none", duration: 0.5, easing: "ease" };

export const DEFAULT_TEXT: TextStyle = {
  content: "Your text",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 72,
  fontWeight: 700,
  italic: false,
  underline: false,
  align: "center",
  letterSpacing: 0,
  lineHeight: 1.2,
  color: "#ffffff",
  strokeColor: "#000000",
  strokeWidth: 0,
  shadowBlur: 0,
  shadowColor: "rgba(0,0,0,0.6)",
  background: null,
  backgroundPadding: 16,
};

export const DEFAULT_SHAPE: ShapeStyle = {
  kind: "rectangle",
  fill: "#4f8cff",
  stroke: "#ffffff",
  strokeWidth: 0,
  points: 5,
  cornerRadius: 0,
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 44,
  color: "#ffffff",
  background: "rgba(0,0,0,0.65)",
  strokeColor: "#000000",
  strokeWidth: 0,
  y: 0.86,
  align: "center",
};

export const DEFAULT_GUIDES: Guides = {
  grid: false,
  thirds: false,
  center: false,
  titleSafe: false,
  actionSafe: false,
  snapToGuides: true,
};

/** Where a clip lives. Clips are identified by track because ids are only
 *  unique within a project and lookups happen on every render. */
export interface ClipRef {
  trackId: string;
  clipId: string;
}
