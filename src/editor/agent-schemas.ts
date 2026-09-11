/**
 * Runtime schemas for the parts of the document an agent can write.
 *
 * These mirror `types.ts`, and `agent-bridge.ts` checks at compile time that
 * what each one produces is assignable to the type it stands for — so a field
 * added to a type without a schema fails the typecheck rather than silently
 * becoming something the agent cannot set.
 *
 * No DOM and no "@/" imports: the server loads this file too.
 */

import { z } from "zod";
import { THEME_IDS } from "./themes";

export const seconds = (what: string) => z.number().min(0).describe(`${what}, in seconds`);
export const unit = (what: string) => z.number().describe(`${what}, 0..1 of the frame`);
export const color = z.string().min(1).describe("CSS colour, e.g. #ff3b30 or rgba(0,0,0,0.5)");
export const id = (what: string) => z.string().min(1).describe(what);

export const trackId = id("Track id, from get_project");
export const clipId = id("Clip id, from get_project");
/** Every clip tool takes these two; clips are addressed by track. */
export const clipRef = { trackId, clipId };

export const easing = z.enum(["linear", "ease", "easeIn", "easeOut", "hold"]);

export const blendMode = z.enum([
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
]);

export const transformPatch = z
  .object({
    x: unit("Horizontal position of the anchor"),
    y: unit("Vertical position of the anchor"),
    scale: z.number().min(0).describe("1 fits the layer inside the frame"),
    scaleX: z.number().min(0),
    scaleY: z.number().min(0),
    rotation: z.number().describe("Degrees, clockwise"),
    anchorX: z.number().describe("0..1 within the layer"),
    anchorY: z.number().describe("0..1 within the layer"),
    opacity: z.number().min(0).max(1),
    flipH: z.boolean(),
    flipV: z.boolean(),
    crop: z
      .object({
        top: z.number().min(0).max(0.45),
        right: z.number().min(0).max(0.45),
        bottom: z.number().min(0).max(0.45),
        left: z.number().min(0).max(0.45),
      })
      .describe("Fraction cut from each edge; all four are required"),
    radius: z.number().min(0).describe("Corner rounding in px at 1080p"),
    shape: z.enum(["rect", "circle"]),
    shadow: z.number().min(0),
    blendMode,
  })
  .partial();

export const colorPatch = z
  .object({
    exposure: z.number(), brightness: z.number(), contrast: z.number(), saturation: z.number(),
    vibrance: z.number(), temperature: z.number(), tint: z.number(), hue: z.number(),
    highlights: z.number(), shadows: z.number(), whites: z.number(), blacks: z.number(),
    sharpen: z.number(), fade: z.number(),
  })
  .partial()
  .describe("0 is neutral for every field; most read sensibly in -100..100");

export const textPatch = z
  .object({
    content: z.string(),
    fontFamily: z.string(),
    fontSize: z.number().min(1).describe("px at 1080p"),
    fontWeight: z.number().min(100).max(900),
    italic: z.boolean(),
    underline: z.boolean(),
    align: z.enum(["left", "center", "right"]),
    letterSpacing: z.number(),
    lineHeight: z.number().min(0.5),
    color,
    strokeColor: color,
    strokeWidth: z.number().min(0),
    shadowBlur: z.number().min(0),
    shadowColor: color,
    background: color.nullable(),
    backgroundPadding: z.number().min(0),
  })
  .partial();

export const shapePatch = z
  .object({
    kind: z.enum(["rectangle", "ellipse", "line", "triangle", "star", "arrow"]),
    fill: color,
    stroke: color,
    strokeWidth: z.number().min(0),
    points: z.number().int().min(3).describe("Stars only"),
    cornerRadius: z.number().min(0),
  })
  .partial();

export const maskPatch = z
  .object({
    shape: z.enum(["none", "rect", "ellipse"]),
    x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0),
    feather: z.number().min(0), rotation: z.number(), invert: z.boolean(),
  })
  .partial()
  .describe("Normalised to the layer's own box");

export const chromaPatch = z
  .object({
    enabled: z.boolean(),
    color,
    similarity: z.number().min(0).max(1),
    smoothness: z.number().min(0).max(1),
    spill: z.number().min(0).max(1),
  })
  .partial();

export const transitionPatch = z
  .object({
    type: z.enum([
      "none", "dissolve", "fadeToBlack", "fadeToWhite", "wipeLeft", "wipeRight", "wipeUp",
      "wipeDown", "pushLeft", "pushRight", "slideUp", "slideDown", "zoom", "blur",
    ]),
    duration: seconds("Length"),
    easing,
  })
  .partial();

export const textAnimation = z.enum(["none", "fade", "slideUp", "slideLeft", "typewriter", "pop", "scale"]);

export const clipRole = z.enum([
  "speaker", "kicker", "title", "subtitle", "body", "muted", "footer", "chip", "chip-positive", "chip-neutral",
  "stat", "label", "label-accent", "number", "icon-positive", "icon-negative", "lower-third-name", "lower-third-role",
  "card", "card-accent", "connector", "connector-accent", "arrow", "node", "node-accent", "node-positive", "bar",
  "bar-accent", "scrim", "lower-third-plate",
]);

export const clipPatch = z
  .object({
    name: z.string(),
    speed: z.number().positive().describe("1 is normal speed"),
    reversed: z.boolean(),
    freeze: z.boolean().describe("Hold one source frame for the whole clip"),
    volume: z.number().min(0).describe("1 is unity gain"),
    pan: z.number().min(-1).max(1),
    muted: z.boolean(),
    fadeIn: seconds("Audio fade in"),
    fadeOut: seconds("Audio fade out"),
    enabled: z.boolean(),
    label: z.string().nullable(),
    textAnimation,
    role: clipRole.describe("What the clip is for, so set_theme can restyle it"),
  })
  .partial();

export const effectType = z.enum([
  "blur", "gaussianBlur", "sharpen", "glow", "grain", "vignette", "pixelate", "posterize",
  "grayscale", "sepia", "invert", "tint", "chromaticAberration", "scanlines",
]);

export const trackPatch = z
  .object({
    name: z.string(),
    muted: z.boolean(),
    solo: z.boolean(),
    hidden: z.boolean(),
    locked: z.boolean(),
    height: z.number().min(24),
    color: color.nullable(),
  })
  .partial();

export const markerPatch = z
  .object({ time: seconds("Timeline position"), duration: seconds("Span"), name: z.string(), note: z.string(), color })
  .partial();

export const captionCue = z.object({
  start: seconds("Start on the timeline"),
  end: seconds("End on the timeline"),
  text: z.string(),
});

export const captionStylePatch = z
  .object({
    fontFamily: z.string(),
    fontSize: z.number().min(1),
    color,
    background: color.nullable(),
    strokeColor: color,
    strokeWidth: z.number().min(0),
    y: z.number().min(0).max(1).describe("0..1 from the top of the frame"),
    align: z.enum(["left", "center", "right"]),
  })
  .partial();

export const guidesPatch = z
  .object({
    grid: z.boolean(), thirds: z.boolean(), center: z.boolean(),
    titleSafe: z.boolean(), actionSafe: z.boolean(), snapToGuides: z.boolean(),
  })
  .partial();

export const background = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solid"), color }),
  z.object({ type: z.literal("gradient"), from: color, to: color, angle: z.number() }),
  z.object({ type: z.literal("transparent") }),
]);

export const projectPatch = z
  .object({
    name: z.string().min(1),
    background,
    padding: z.number().min(0).max(0.4).describe("Inset of the bottom video layer, fraction of the frame"),
    width: z.number().int().min(16),
    height: z.number().int().min(16),
    frameRate: z.number().positive(),
    captionsEnabled: z.boolean(),
    inPoint: z.number().min(0).nullable(),
    outPoint: z.number().min(0).nullable(),
  })
  .partial();

export const layoutStyle = z.enum(["side-panel", "b-roll", "pip", "lower-thirds", "graphics-only"]);

export const briefPatch = z
  .object({
    goal: z.string().describe("What the video should achieve"),
    audience: z.string(),
    platform: z.string().describe("Where it will be watched: YouTube, Reels, a landing page"),
    tone: z.string(),
    layout: layoutStyle.nullable().describe("side-panel: speaker in a panel, graphics beside; b-roll: full-frame cutaways; pip: speaker in a corner; lower-thirds: names and points only; graphics-only: no speaker"),
    language: z.string().describe("Language of on-screen text"),
    captions: z.enum(["yes", "no"]).nullable(),
    brand: z
      .object({
        name: z.string(),
        logoAssetId: z.string().nullable(),
        colors: z.array(color),
        fonts: z.array(z.string()),
        notes: z.string(),
      })
      .partial(),
    references: z
      .array(z.object({ assetId: z.string().nullable().optional(), url: z.string().nullable().optional(), note: z.string() }))
      .describe("Replaces the list"),
    rules: z.array(z.string()).describe("Standing instructions; replaces the list"),
  })
  .partial();

const weight = z.number().int().min(100).max(900);

export const themeId = z.enum(THEME_IDS);

export const themePatch = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    palette: z
      .object({
        background: color, backgroundTo: color.nullable(), surface: color, line: color, text: color, muted: color, dim: color,
        accent: color, accentSoft: color, accentMuted: color, positive: color, positiveSoft: color, negative: color, neutralSoft: color,
      })
      .partial(),
    fonts: z.object({ display: z.string().min(1), body: z.string().min(1) }).partial().describe("Font stacks, web font first, e.g. 'Inter, Helvetica Neue, sans-serif'"),
    weights: z.object({ display: weight, body: weight, kicker: weight, stat: weight }).partial(),
    type: z
      .object({
        kicker: z.number().min(8), title: z.number().min(8), subtitle: z.number().min(8), body: z.number().min(8),
        small: z.number().min(8), stat: z.number().min(8), kickerSpacing: z.number(), kickerUppercase: z.boolean(),
        lineHeight: z.number().min(0.8).max(2),
      })
      .partial()
      .describe("Pixels at 1080p"),
    shape: z.object({ radius: z.number().min(0), stroke: z.number().min(0) }).partial(),
    motion: z
      .object({ enter: textAnimation, move: z.number().min(0.1).max(3), stagger: z.number().min(0).max(2), exit: z.number().min(0).max(2) })
      .partial(),
    layout: z
      .object({ margin: z.number().min(0), panelWidth: z.number().min(0.15).max(0.5), panelInset: z.number().min(0), panelRadius: z.number().min(0) })
      .partial(),
  })
  .partial();

export const assetPatch = z
  .object({
    name: z.string().min(1),
    binId: z.string().nullable(),
    tags: z.array(z.string()),
    rating: z.number().int().min(0).max(5),
    colorLabel: z.string().nullable(),
    favorite: z.boolean(),
  })
  .partial();
