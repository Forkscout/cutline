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
import type { Transcript } from "./transcript";

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

  /**
   * For an SVG: the original, kept beside the PNG it was rasterised to on
   * import (a media-store id). The asset itself is the PNG, so the preview, a
   * rendered frame and the export all decode the same pixels.
   */
  vectorSource?: string;

  /** How a generated sound or still was made: to make the next one the same way, or this one again. */
  generated?: GeneratedAudio | GeneratedImage;

  /** A data URL, cached so the browser does not re-decode on every render. */
  thumbnail?: string;
  /** Normalised min/max pairs per bucket, for drawing waveforms. */
  peaks?: number[];
  /** True when the underlying bytes could not be found on load. */
  offline?: boolean;
  /**
   * What was said, word by word, in the file's own time. Mapped onto the
   * timeline through whichever clips use the asset, so trimming a clip never
   * invalidates it.
   */
  transcript?: Transcript;
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
  /**
   * Seconds from the clip's own start. Edits that move where a clip begins
   * without moving what it shows re-base these (`sliceKeyframes`), so the
   * animation stays put on the timeline; it may be negative after one.
   */
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

/** A figure that counts from `from` to `to`, written the way it was given. */
export interface TextCounter {
  from: number;
  to: number;
  decimals: number;
  /** The grouping: "en-IN" writes 1,26,000, "en-US" 126,000. */
  locale: string;
  grouping: boolean;
  prefix: string;
  suffix: string;
}

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
  /**
   * How many lines are shown, from the top: line i is drawn at reveal − i
   * opacity (0..1), rising into place as it arrives. Unset shows every line.
   * Keyframed as `text.reveal`, it brings rows in on their words while the
   * whole column stays one clip — a table is a clip per column, not per cell.
   */
  reveal?: number;
  /**
   * A number counting instead of the content, which keeps the final figure
   * (counter.ts). The box is measured from that figure and digits are drawn
   * tabular, so nothing shifts while it counts.
   */
  counter?: TextCounter;
  /** How far the counter has counted, 0..1; keyframed as `text.counterValue`. */
  counterValue?: number;
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

export type ShapeKind = "rectangle" | "ellipse" | "line" | "triangle" | "star" | "arrow" | "path";

export interface ShapeStyle {
  kind: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Star and polygon only. */
  points: number;
  cornerRadius: number;
  /**
   * Path only: SVG path data in the shape's own box — 0..1 across and down
   * from its top-left — so it resizes with the shape and its stroke keeps its
   * width. Arc radii are in the same units: rx r/w and ry r/h draw a circle.
   * One clip can hold many marks: every empty seat and edge of a tree.
   */
  path?: string;
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
   * What a clip made from theme tokens is for — title, chip, card. Set by the
   * agent's macros; a theme change restyles every clip that has one.
   */
  role?: ClipRole;
  /** The storyboard scene and component this clip was compiled from. */
  scene?: string;
  component?: string;
  /**
   * The user changed this clip by hand. A compile leaves it where it is: the
   * agent never undoes the user's work.
   */
  userEdited?: boolean;

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
  /** A note pinned to a place in the picture, 0..1 of the frame. */
  pin?: { x: number; y: number };
  /** The client reviewing, or an agent leaving a note for them. */
  author?: "client" | "agent";
  /** Dealt with, and what was done, in the words of whoever did it. */
  resolved?: boolean;
  reply?: string;
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

/**
 * A number or name on screen that someone should confirm before the video
 * ships. An agent flags what it was unsure of; the facts check adds figures
 * nobody said nearby; the client confirms or corrects.
 */
export interface Fact {
  id: string;
  /** As it appears on screen: "21,000", "Level 7", "Priya Shah". */
  value: string;
  status: "open" | "confirmed" | "corrected" | "dismissed";
  /** Why it is in doubt, or what the client said: "the transcript heard 7". */
  note?: string;
  /** What it replaced, once corrected. */
  was?: string;
  /** An agent that was unsure, or the check that found it unheard. */
  source: "agent" | "scan";
  /** When it is on screen, for a play button. */
  time?: number;
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

  /** What the video is for, as the client said it — read first by every agent. */
  brief: Brief;
  /** The design tokens graphics are made from; null until one is chosen. */
  theme: Theme | null;
  /** What the video shows, scene by scene; compiled into clips. */
  storyboard: Storyboard | null;
  /** Numbers and names on screen to confirm before the video ships. */
  facts: Fact[];
  /** Which connected service fills each role here; unset means the workspace's. */
  services: ProjectServices;
  /** The speakers this project's voiceovers are read in. */
  voices: VoiceProfile[];
  /** The looks this project's generated stills are drawn in. */
  imageStyles: ImageStyle[];
}

/**
 * The services this project uses, by role, as ids of what is connected. What
 * is connected lives in ~/Cutline/ai.json, not in the project: a project says
 * which one it wants, never how to reach it, and never a key.
 */
export interface ProjectServices {
  transcribe?: string;
  chat?: string;
  voice?: string;
  image?: string;
  video?: string;
}

/* ------------------------------------------------------------------ voice */

/**
 * A speaker a project's voiceovers are read in, chosen once and used for every
 * line, so a line read next week — by another agent, or by the user in the
 * Voice panel — sounds like the rest.
 */
export interface VoiceProfile {
  id: string;
  /** Who is speaking: "Narrator", "Priya (host)". */
  name: string;
  /** The service it was set up on; unset uses the project's voice service. */
  providerId?: string;
  /** Pinned: a service's default model can change, and a different model is a different voice. */
  model: string;
  voice: string;
  speed?: number;
  /** The standing direction sent with every line: tone, pace, accent, language. */
  instructions?: string;
  language?: string;
  /** Why this voice: what the client said. */
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/** How a generated sound was read, kept on its asset. */
export interface GeneratedAudio {
  kind: "voice";
  /** The script, as it was sent. */
  text: string;
  profileId?: string;
  /** The profile's name when it was read; it survives a renamed or removed profile. */
  speaker?: string;
  providerId: string;
  /** The service's name when it was read. */
  service: string;
  model: string;
  voice: string;
  speed?: number;
  instructions?: string;
  createdAt: number;
  by: "agent" | "user";
}

/* ------------------------------------------------------------------ image */

/** How a still placed as B-roll moves: a still that does not move looks dead. */
export type KenBurns = "none" | "push-in" | "pull-out" | "pan-left" | "pan-right";

/**
 * A look a project's generated stills are drawn in, chosen once and used for
 * every image, so B-roll drawn next week — by another agent, or by the user —
 * belongs to the same film.
 */
export interface ImageStyle {
  id: string;
  /** "Documentary B-roll", "Product close-ups". */
  name: string;
  /** The service it was set up on; unset uses the project's image service. */
  providerId?: string;
  /** Pinned: another model is another look. "current" follows whatever Draw Things has selected. */
  model: string;
  /** The look in words, added to every subject: light, lens, palette, texture. */
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps?: number;
  guidance?: number;
  sampler?: string;
  /** One seed for the whole look, so similar subjects compose alike; unset draws each with its own. */
  seed?: number;
  /** How a still in this look moves when placed. */
  motion?: KenBurns;
  /** Why this look: what the client said. */
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/** How a generated still was drawn, kept on its asset: to draw it again, or another take. */
export interface GeneratedImage {
  kind: "image";
  /** The subject asked for, without the look's words. */
  prompt: string;
  /** Exactly what was sent: the subject with the look's words. */
  sentPrompt: string;
  negativePrompt?: string;
  styleId?: string;
  /** The look's name when it was drawn; it survives a renamed or removed look. */
  style?: string;
  /** Unset when a tool outside Cutline did not say. */
  seed?: number;
  /** The size asked for; the asset has the size that came back. */
  width: number;
  height: number;
  steps?: number;
  guidance?: number;
  sampler?: string;
  /** The connected service that drew it; unset for a picture made outside Cutline and imported. */
  providerId?: string;
  /** Who drew it: a connected service's name, or the tool outside Cutline that made it. */
  service: string;
  model: string;
  /** What the service says it drew with, when it differs from what was asked. */
  modelUsed?: string;
  /** The still this is another take of. */
  variationOf?: string;
  createdAt: number;
  by: "agent" | "user";
}

/* ------------------------------------------------------------- storyboard */

/** A moment: a time on the timeline, or the first time a phrase is said after the one before it. */
export type Anchor = { time: number; offset?: number } | { word: string; offset?: number };

type Item<T> = T & { at: Anchor };

export type StoryComponent = { id: string; until?: Anchor; y?: number } & (
  | { type: "title"; at: Anchor; kicker?: string; title: string; subtitle?: string }
  | { type: "points"; items: Item<{ text: string; icon?: "check" | "cross" | "dot" | "number" | "none"; lead?: string }>[] }
  | { type: "chips"; items: Item<{ text: string; tone?: "accent" | "positive" | "neutral" }>[] }
  | { type: "stat"; at: Anchor; value: string; label?: string; count?: boolean }
  | { type: "statement"; lines: Item<{ text: string; tone?: "text" | "accent" | "muted" }>[]; size?: "hero" | "stat" | "title" }
  | { type: "flow"; steps: Item<{ text: string; style?: "box" | "pill" }>[]; highlight?: "last" | "none" }
  | { type: "cards"; cards: Item<{ kicker?: string; title: string; body?: string }>[]; highlight?: "last" | "first" | "none" }
  | { type: "split"; source: Item<{ text: string }>; branches: Item<{ title: string; body?: string }>[] }
  | {
      type: "bars";
      items: Item<{ label: string; value: number; display?: string }>[];
      orientation?: "horizontal" | "vertical";
      scale?: "linear" | "log";
      highlight?: "last" | "max" | "none";
      height?: number;
    }
  | { type: "tally"; items: Item<{ label: string; count: number; value: string }>[] }
  | {
      type: "tree";
      nodes: Item<{ id: string; label: string; parent?: string | null; tone?: "accent" | "positive" | "neutral"; note?: string; flash?: boolean }>[];
      moves?: Item<{ node: string; parent: string; flash?: boolean }>[];
      /** Draw the empty seats and edges faintly, this many levels below the root. */
      ghost?: number;
    }
  | {
      type: "table";
      columns: { header?: string; align?: "left" | "center" | "right" }[];
      /** A cell with its own anchor arrives then: a column that fills in later. */
      rows: Item<{ cells: (string | { text: string; at: Anchor })[] }>[];
      /** Rows set on an accent card, counted from 0. */
      highlight?: number[];
    }
  | { type: "stack"; items: Item<{ title: string; value?: string; tone?: "accent" | "neutral" }>[]; connectors?: string[] }
  | { type: "flash"; at: Anchor; node: string; tree?: string }
  | { type: "coin"; stops: Item<{ node: string }>[]; tree?: string }
  | { type: "lower_third"; at: Anchor; name: string; role?: string }
);

export type SceneLayout = "panel" | "full" | "pip" | "backdrop";

export interface StoryScene {
  id: string;
  from: Anchor;
  to: Anchor;
  layout: SceneLayout;
  side?: "right" | "left";
  subjectX?: number;
  /** A locked scene keeps its clips through every compile. */
  locked?: boolean;
  /** What the scene is for, in a line: shown on its storyboard card. */
  note?: string;
  components: StoryComponent[];
}

export interface Storyboard {
  version: 1;
  /** A line shown at the foot of every panel scene. */
  footer?: string;
  /** Where the subject sits across the source (analyze_media); a scene may override it. */
  subjectX?: number;
  scenes: StoryScene[];
  compiledAt: number | null;
}

/* -------------------------------------------------------------- direction */

/** How the speaker and the graphics share the frame. */
export type LayoutStyle = "side-panel" | "b-roll" | "pip" | "lower-thirds" | "graphics-only";

export interface BriefReference {
  id: string;
  /** A reference imported into the project, to look at with contact_sheet. */
  assetId: string | null;
  url: string | null;
  /** What to take from it: "the pacing", "the lower thirds". */
  note: string;
}

export interface BriefDecision {
  at: number;
  text: string;
}

/**
 * What the video is for and how it should feel, written down once and kept
 * with the project — so the second agent to open it does not re-ask the client
 * what the first one already learned.
 */
export interface Brief {
  goal: string;
  audience: string;
  /** Where it will be watched: YouTube, Reels, a landing page. */
  platform: string;
  tone: string;
  layout: LayoutStyle | null;
  /** Language of the words on screen. */
  language: string;
  captions: "yes" | "no" | null;
  brand: { name: string; logoAssetId: string | null; colors: string[]; fonts: string[]; notes: string };
  references: BriefReference[];
  /** Standing instructions: "numbers on screen are checked by the client first". */
  rules: string[];
  /** What was decided and why, oldest first. */
  decisions: BriefDecision[];
  /** Where the brand kit, recipe and look came from, and which version: copies, not links. */
  sources: BriefSources;
  updatedAt: number;
}

export interface ThemePalette {
  background: string;
  /** A second stop makes the background a gradient. */
  backgroundTo: string | null;
  surface: string;
  line: string;
  text: string;
  muted: string;
  dim: string;
  accent: string;
  accentSoft: string;
  accentMuted: string;
  positive: string;
  positiveSoft: string;
  negative: string;
  neutralSoft: string;
}

/**
 * The look of everything an agent adds — tokens, not styles. Sizes are pixels
 * at 1080p. `themes.ts` has the built-in themes and the rules that turn a
 * clip's role into its style.
 */
export interface Theme {
  id: string;
  name: string;
  description: string;
  palette: ThemePalette;
  /** Font stacks, web font first. */
  fonts: { display: string; body: string };
  weights: { display: number; body: number; kicker: number; stat: number };
  type: {
    kicker: number;
    title: number;
    subtitle: number;
    body: number;
    small: number;
    stat: number;
    kickerSpacing: number;
    kickerUppercase: boolean;
    lineHeight: number;
  };
  shape: { radius: number; stroke: number };
  motion: {
    enter: TextAnimation;
    /** Seconds a layout move takes. */
    move: number;
    /** Seconds between items that arrive together. */
    stagger: number;
    /** Seconds an element takes to leave. */
    exit: number;
  };
  layout: {
    /** Left and right margin of the graphics, px. */
    margin: number;
    /** The speaker's panel, as a fraction of the frame's width. */
    panelWidth: number;
    /** Gap between the panel and the frame's edge, px. */
    panelInset: number;
    panelRadius: number;
  };
}

export type ClipRole =
  | "speaker"
  | "kicker"
  | "title"
  | "subtitle"
  | "body"
  | "muted"
  | "footer"
  | "chip"
  | "chip-positive"
  | "chip-neutral"
  | "stat"
  | "label"
  | "label-accent"
  | "label-positive"
  | "number"
  | "icon-positive"
  | "icon-negative"
  | "lower-third-name"
  | "lower-third-role"
  | "card"
  | "card-accent"
  | "connector"
  | "connector-accent"
  | "arrow"
  | "node"
  | "node-accent"
  | "node-positive"
  | "bar"
  | "bar-accent"
  | "scrim"
  | "lower-third-plate"
  | "flash"
  | "coin"
  | "ghost";

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

export const EMPTY_BRIEF: Brief = {
  goal: "",
  audience: "",
  platform: "",
  tone: "",
  layout: null,
  language: "",
  captions: null,
  brand: { name: "", logoAssetId: null, colors: [], fonts: [], notes: "" },
  references: [],
  rules: [],
  decisions: [],
  sources: {},
  updatedAt: 0,
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

/* -------------------------------------------------------------- workspace */

/** Where a project's brand kit, recipe and look came from, and which version of each. */
export interface BriefSources {
  brandKit?: { id: string; name: string; version: number };
  recipe?: { id: string; name: string; version: number };
  look?: { id: string; name: string; version: number };
}

/** Anything kept in the workspace: reused across videos, copied into each project that uses it. */
export interface WorkspaceItem {
  id: string;
  name: string;
  /** Bumped on every save: a project whose copy is older can offer the update. */
  version: number;
  updatedAt: number;
}

export interface BrandKit extends WorkspaceItem {
  /** Files kept with the kit, by what they are for; the values are file names in its folder. */
  files: { logo?: string; logoDark?: string; intro?: string; outro?: string; watermark?: string };
  colors: string[];
  /** Google Fonts families, or faces installed on the machine: display first, then body. */
  fonts: string[];
  tone: string;
  /** Standing instructions: "never show prices without a date". */
  rules: string[];
  layout: LayoutStyle | null;
  /** How a lower third names the speaker, unless the brief says otherwise. */
  lowerThird: { name: string; role: string };
  notes: string;
}

export interface Look extends WorkspaceItem {
  description: string;
  theme: Theme;
}

export interface Recipe extends WorkspaceItem {
  description: string;
  /** Defaults for the brief; they never overwrite what the client said. */
  brief: {
    platform?: string;
    layout?: LayoutStyle;
    captions?: "yes" | "no";
    tone?: string;
    audience?: string;
    rules?: string[];
  };
  /** Worth asking the client, beyond the brief's own questions. */
  questions: string[];
  /** How the storyboard usually goes. */
  patterns: string[];
  /** Checks before export. */
  qa: string[];
  exports: { name: string; width: number; height: number }[];
  builtIn?: boolean;
}

export interface WorkspaceReference extends WorkspaceItem {
  url: string | null;
  /** A video or image kept with the reference. */
  file?: string;
  /** What to take from it: "the pacing", "these lower thirds". */
  note: string;
  tags: string[];
}
