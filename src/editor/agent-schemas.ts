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
    reveal: z.number().min(0).describe("Lines shown from the top: line i is drawn at reveal − i opacity. Keyframe text.reveal to bring rows in one by one"),
    counter: z
      .object({
        from: z.number(),
        to: z.number(),
        decimals: z.number().int().min(0).max(4),
        locale: z.string().max(20).describe("en-IN writes 1,26,000; en-US 126,000"),
        grouping: z.boolean(),
        prefix: z.string().max(12),
        suffix: z.string().max(24),
      })
      .partial()
      .nullable()
      .describe("Count a number instead of showing content. What is left out is read from the figure the text shows (₹1,26,000 → en-IN, prefix ₹, from 0); null stops counting. Then keyframe text.counterValue 0 → 1"),
    counterValue: z.number().min(0).max(1).describe("How far a counter has counted, 0..1"),
  })
  .partial();

export const shapePatch = z
  .object({
    kind: z.enum(["rectangle", "ellipse", "line", "triangle", "star", "arrow", "path"]),
    fill: color,
    stroke: color,
    strokeWidth: z.number().min(0),
    points: z.number().int().min(3).describe("Stars only"),
    cornerRadius: z.number().min(0),
    path: z.string().max(20000).describe("kind path: SVG path data in the shape's own box, 0..1 across and down from its top-left; arc radii too (rx r/w, ry r/h is a circle)"),
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
  "stat", "label", "label-accent", "label-positive", "number", "icon-positive", "icon-negative", "lower-third-name", "lower-third-role",
  "card", "card-accent", "connector", "connector-accent", "arrow", "node", "node-accent", "node-positive", "bar",
  "bar-accent", "scrim", "lower-third-plate", "flash", "coin", "ghost",
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
  .object({
    time: seconds("Timeline position"),
    duration: seconds("Span"),
    name: z.string(),
    note: z.string(),
    color,
    pin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).describe("Pins a note to a place in the picture, 0..1 of the frame"),
    author: z.enum(["client", "agent"]),
    resolved: z.boolean(),
    reply: z.string().max(500),
  })
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

/* -------------------------------------------------------------- storyboard */

export const anchor = z
  .union([
    z.object({ time: z.number().min(0), offset: z.number().optional() }),
    z.object({
      word: z.string().min(1).max(80).describe("A phrase as it appears in the transcript — its first occurrence after the previous anchor"),
      offset: z.number().optional().describe("Seconds added to the word's start; negative is earlier"),
    }),
  ])
  .describe("{ time } on the timeline, or { word } — when that phrase is said");

const common = {
  id: z.string().min(1).max(60).describe("Stable: locks, notes and recompiles follow it"),
  until: anchor.optional().describe("When it leaves; default the scene's end"),
  y: z.number().min(0).optional().describe("Top edge, px at 1080p; default under what the scene already shows"),
};
const tone3 = z.enum(["accent", "positive", "neutral"]);

export const storyComponent = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("title"), at: anchor, kicker: z.string().max(60).optional(), title: z.string().min(1).max(160), subtitle: z.string().max(240).optional() }),
  z.object({
    ...common,
    type: z.literal("points"),
    items: z
      .array(z.object({ at: anchor, text: z.string().min(1).max(200), icon: z.enum(["check", "cross", "dot", "number", "none"]).optional(), lead: z.string().max(30).optional() }))
      .min(1)
      .max(10),
  }),
  z.object({ ...common, type: z.literal("chips"), items: z.array(z.object({ at: anchor, text: z.string().min(1).max(40), tone: tone3.optional() })).min(1).max(12) }),
  z.object({ ...common, type: z.literal("stat"), at: anchor, value: z.string().min(1).max(16), label: z.string().max(120).optional(), count: z.boolean().optional().describe("Count up to the value as it arrives") }),
  z.object({
    ...common,
    type: z.literal("statement"),
    lines: z.array(z.object({ at: anchor, text: z.string().min(1).max(80), tone: z.enum(["text", "accent", "muted"]).optional() })).min(1).max(4),
    size: z.enum(["hero", "stat", "title"]).optional(),
  }),
  z.object({
    ...common,
    type: z.literal("flow"),
    steps: z.array(z.object({ at: anchor, text: z.string().min(1).max(80), style: z.enum(["box", "pill"]).optional() })).min(2).max(5),
    highlight: z.enum(["last", "none"]).optional(),
  }),
  z.object({
    ...common,
    type: z.literal("cards"),
    cards: z.array(z.object({ at: anchor, kicker: z.string().max(40).optional(), title: z.string().min(1).max(80), body: z.string().max(200).optional() })).min(1).max(4),
    highlight: z.enum(["last", "first", "none"]).optional(),
  }),
  z.object({
    ...common,
    type: z.literal("split"),
    source: z.object({ at: anchor, text: z.string().min(1).max(60) }),
    branches: z.array(z.object({ at: anchor, title: z.string().min(1).max(60), body: z.string().max(200).optional() })).min(2).max(3),
  }),
  z.object({
    ...common,
    type: z.literal("bars"),
    items: z.array(z.object({ at: anchor, label: z.string().min(1).max(30), value: z.number(), display: z.string().max(20).optional() })).min(2).max(12),
    orientation: z.enum(["horizontal", "vertical"]).optional(),
    scale: z.enum(["linear", "log"]).optional(),
    highlight: z.enum(["last", "max", "none"]).optional(),
    height: z.number().min(120).max(700).optional(),
  }),
  z.object({
    ...common,
    type: z.literal("tally"),
    items: z.array(z.object({ at: anchor, label: z.string().min(1).max(30), count: z.number().int().min(0).max(999), value: z.string().max(30) })).min(1).max(6),
  }),
  z.object({
    ...common,
    type: z.literal("tree"),
    nodes: z
      .array(
        z.object({
          at: anchor,
          id: z.string().min(1).max(30),
          label: z.string().min(1).max(12),
          parent: z.string().nullable().optional().describe("Omit for a root, or for a node that arrives unattached and moves later"),
          tone: tone3.optional(),
          note: z.string().max(40).optional().describe("A line under the node"),
          flash: z.boolean().optional().describe("A ring flashes on it as it arrives"),
        }),
      )
      .min(1)
      .max(15),
    moves: z.array(z.object({ at: anchor, node: z.string(), parent: z.string(), flash: z.boolean().optional().describe("A ring flashes where it lands") })).max(5).optional(),
    ghost: z.number().int().min(1).max(4).optional().describe("Also draw the empty seats and edges faintly, this many levels below the root"),
  }),
  z.object({
    ...common,
    type: z.literal("table"),
    columns: z.array(z.object({ header: z.string().max(40).optional(), align: z.enum(["left", "center", "right"]).optional() })).min(1).max(6),
    rows: z
      .array(z.object({ at: anchor, cells: z.array(z.union([z.string().max(60), z.object({ text: z.string().max(60), at: anchor })])).min(1).max(6) }))
      .min(1)
      .max(14)
      .describe("A cell given as { text, at } arrives at its own word — a column that fills in later"),
    highlight: z.array(z.number().int().min(0)).max(4).optional().describe("Rows set on an accent card, from 0"),
  }),
  z.object({
    ...common,
    type: z.literal("stack"),
    items: z.array(z.object({ at: anchor, title: z.string().min(1).max(60), value: z.string().max(24).optional(), tone: z.enum(["accent", "neutral"]).optional() })).min(1).max(8),
    connectors: z.array(z.string().max(24)).max(7).optional().describe("Labels in the gaps between cards, top to bottom: '↓ ×6'"),
  }),
  z.object({ ...common, type: z.literal("flash"), at: anchor, node: z.string().min(1).max(30), tree: z.string().max(60).optional().describe("The tree component the node is in; default any in this scene") }),
  z.object({ ...common, type: z.literal("coin"), stops: z.array(z.object({ at: anchor, node: z.string().min(1).max(30) })).min(2).max(8), tree: z.string().max(60).optional() }),
  z.object({ ...common, type: z.literal("lower_third"), at: anchor, name: z.string().min(1).max(60), role: z.string().max(80).optional() }),
]);

export const storyScene = z.object({
  id: z.string().min(1).max(60),
  from: anchor,
  to: anchor,
  layout: z.enum(["panel", "full", "pip", "backdrop"]).describe("panel: speaker in a side panel; full: speaker full frame; pip: speaker in a corner; backdrop: full frame under a scrim, graphics over it"),
  side: z.enum(["right", "left"]).optional(),
  subjectX: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
  note: z.string().max(200).optional().describe("What the scene is for, in a line"),
  components: z.array(storyComponent).max(8),
});

export const storyboard = z.object({
  footer: z.string().max(80).optional().describe("A line at the foot of every scene that is not full frame"),
  subjectX: z.number().min(0).max(1).optional().describe("Where the subject sits across the source, from analyze_media"),
  scenes: z.array(storyScene).min(1).max(80),
});

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

/** Where a fact to confirm stands; corrected comes only from correct_fact. */
export const factStatus = z.enum(["open", "confirmed", "dismissed"]);
