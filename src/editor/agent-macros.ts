/**
 * Macros: whole graphic devices in one call — a title block, a list of points,
 * a row of chips, a big number, a flow of boxes, bars, a lower third — made
 * from the project's theme.
 *
 * An agent can place every text and shape itself, and the TreeFlux edit did:
 * ~1300 calls, every colour and size typed by hand, chip widths guessed from a
 * table, and a change of look meant a rebuild. A macro measures text in the
 * theme's own faces, lays items out in the space beside the speaker, stacks
 * under whatever the scene already shows, picks tracks with room, times each
 * item to the word it is given, and tags every clip with its role so
 * set_theme can restyle it later.
 *
 * Runs in the tab: it measures on a canvas and commits one reducer action per
 * clip through the bridge, inside the agent's turn.
 */

import { clipBox, visibleClips } from "./compositor";
import { clipAt, readProperty, valueAt } from "./keyframes";
import { shapeClip, textClip, type Action } from "./project";
import { shapeStyleFor, textStyleFor, themeOf } from "./themes";
import type { Clip, ClipRef, ClipRole, Keyframe, Project, ShapeKind, TextAnimation, Theme, Track, Transition } from "./types";

export interface Font {
  family: string;
  weight: number;
  /** Pixels in the project's frame. */
  size: number;
  letterSpacing?: number;
}

export interface MacroContext {
  /** The live project, read again after every commit. */
  project(): Project;
  /**
   * Stamped on every clip made: a storyboard compile's scene and component, or
   * the component one tool call makes, so it can be moved or deleted whole.
   */
  tag?: { scene?: string; component: string };
  commit(action: Action): void;
  /** Width of one line of text, in the project's pixels. */
  measure(text: string, font: Font): number;
}

/** A mistake the agent can fix, reported back as the tool's error. */
export class MacroError extends Error {}

let measurer: CanvasRenderingContext2D | null = null;

/** Width of a line of text as the compositor will draw it: the same canvas font string. */
export function measureOnCanvas(text: string, font: Font): number {
  measurer ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measurer) return text.length * font.size * 0.55;
  measurer.font = `${font.weight} ${font.size}px ${font.family}`;
  if ("letterSpacing" in measurer) (measurer as unknown as { letterSpacing: string }).letterSpacing = `${font.letterSpacing ?? 0}px`;
  return Math.max(...text.split("\n").map((line) => measurer!.measureText(line).width));
}

export interface Placed {
  role: ClipRole;
  trackId: string;
  clipId: string;
  start: number;
  end: number;
}

export interface MacroResult {
  clips: Placed[];
  /** Where the next element in this scene can start, px at the project's height. */
  bottom?: number;
  notes: string[];
}

const REFERENCE_HEIGHT = 1080;

const keyframe = (property: string, time: number, value: number, easing: Keyframe["easing"] = "ease"): Keyframe => ({
  id: crypto.randomUUID(),
  property,
  time: Math.max(0, time),
  value,
  easing,
});
const dissolve = (duration: number): Transition => ({ type: "dissolve", duration, easing: "ease" });

/** A flash ring's life, and a coin's longest trip between two stops, in seconds. */
const FLASH = 0.7;
const TRAVEL = 0.9;

/* -------------------------------------------------------------- the frame */

interface Frame {
  project: Project;
  theme: Theme;
  W: number;
  H: number;
  /** Project pixels per 1080p pixel. */
  u: number;
}

function frameOf(ctx: MacroContext): Frame {
  const project = ctx.project();
  return { project, theme: themeOf(project), W: project.width, H: project.height, u: project.height / REFERENCE_HEIGHT };
}

export interface Speaker {
  track: Track;
  trackIndex: number;
  clip: Clip;
}

/** The speaker at a time: the clip tagged so, or the lowest video clip that shows pictures. */
export function findSpeaker(project: Project, time: number): Speaker | null {
  return speakerAt(project, time);
}

function speakerAt(project: Project, time: number): Speaker | null {
  const visible = visibleClips(project, time).filter(({ track, clip }) => {
    if (track.kind !== "video" || clip.kind !== "media") return false;
    return Boolean(project.assets.find((a) => a.id === clip.assetId)?.hasVideo);
  });
  const found = visible.find(({ clip }) => clip.role === "speaker") ?? visible[0];
  if (!found) return null;
  return { track: found.track, trackIndex: project.tracks.indexOf(found.track), clip: found.clip };
}

export interface Zone {
  x0: number;
  x1: number;
  /** The speaker fills the frame: graphics will sit over the picture. */
  full: boolean;
}

/** The horizontal space graphics may use at a time: beside the speaker's panel, or the whole frame. */
export function zoneAt(f: Frame, time: number): Zone {
  const margin = f.theme.layout.margin * f.u;
  const speaker = speakerAt(f.project, time);
  if (speaker) {
    const asset = f.project.assets.find((a) => a.id === speaker.clip.assetId);
    const local = time - speaker.clip.start;
    const animated = structuredClone(speaker.clip);
    for (const k of new Set(speaker.clip.keyframes.map((k) => k.property))) {
      const value = valueAt(speaker.clip, k, local);
      if (value !== undefined) setPath(animated, k, value);
    }
    const firstVideo = f.project.tracks.findIndex((t) => t.kind === "video");
    const box = asset ? clipBox(f.project, animated, { width: asset.width, height: asset.height }, speaker.trackIndex === firstVideo) : null;
    if (box && box.w < f.W * 0.6) {
      const left = box.cx + box.x;
      const right = left + box.w;
      if (left > f.W / 2) return { x0: margin, x1: left - margin * 0.6, full: false };
      if (right < f.W / 2) return { x0: right + margin * 0.6, x1: f.W - margin, full: false };
    }
  }
  return { x0: margin, x1: f.W - margin, full: true };
}

function setPath(target: object, path: string, value: number): void {
  const parts = path.split(".");
  let current = target as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) current = current[part] as Record<string, unknown>;
  current[parts[parts.length - 1]!] = value;
}

/** The lowest edge of anything a macro placed in this zone during these times, or null when the scene is empty. */
function lowestEdge(f: Frame, zone: Zone, start: number, end: number): number | null {
  let lowest: number | null = null;
  for (const track of f.project.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      if (!clip.role || ["speaker", "scrim", "footer"].includes(clip.role)) continue;
      if (clip.start >= end || clip.start + clip.duration <= start) continue;
      const x = clip.transform.x * f.W;
      if (x < zone.x0 - 1 || x > zone.x1 + 1) continue;
      let bottom: number;
      if (clip.text) {
        const lines = clip.text.content.split("\n").length;
        bottom = clip.transform.y * f.H + (lines * clip.text.fontSize * f.u * clip.text.lineHeight) / 2 + (clip.text.background ? clip.text.backgroundPadding * f.u : 0);
      } else {
        bottom = clip.transform.y * f.H + (f.H * 0.3 * clip.transform.scale * clip.transform.scaleY) / 2;
      }
      lowest = Math.max(lowest ?? 0, bottom);
    }
  }
  return lowest;
}

/** Greedy word wrap to a width. */
function wrap(ctx: MacroContext, text: string, width: number, font: Font): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measure(next, font) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------- building */

class Build {
  readonly clips: Placed[] = [];
  readonly notes: string[] = [];
  private floor: number;

  constructor(
    private readonly ctx: MacroContext,
    readonly f: Frame,
    /** Everything goes above this track: the speaker's, or the first video track. */
    base: number,
  ) {
    this.floor = base;
  }

  /** A video track above the last one this build used, with nothing on it between start and end. */
  private trackFor(start: number, end: number): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = this.ctx.project();
      for (let i = this.floor + 1; i < project.tracks.length; i += 1) {
        const track = project.tracks[i]!;
        if (track.kind !== "video" || track.locked || track.hidden) continue;
        if (track.clips.every((c) => c.start + c.duration <= start + 1e-3 || c.start >= end - 1e-3)) {
          this.floor = i;
          return track.id;
        }
      }
      // Appended last: later video tracks draw on top.
      this.ctx.commit({ type: "addTrack", kind: "video" });
    }
    throw new MacroError("Could not find or make a free video track.");
  }

  add(clip: Clip, role: ClipRole): Placed {
    clip.role = role;
    if (this.ctx.tag) {
      if (this.ctx.tag.scene) clip.scene = this.ctx.tag.scene;
      clip.component = this.ctx.tag.component;
    }
    const trackId = this.trackFor(clip.start, clip.start + clip.duration);
    this.ctx.commit({ type: "addClip", trackId, clip });
    const placed: Placed = { role, trackId, clipId: clip.id, start: clip.start, end: clip.start + clip.duration };
    this.clips.push(placed);
    return placed;
  }

  text(
    role: ClipRole,
    content: string,
    at: { x: number; y: number },
    size: number,
    start: number,
    end: number,
    o: {
      align?: "left" | "center" | "right";
      anim?: TextAnimation;
      lineHeight?: number;
      pad?: number;
      weight?: number;
      spacing?: number;
      keyframes?: Keyframe[];
    } = {},
  ): Placed {
    const { theme, W, H } = this.f;
    const clip = textClip(start, Math.max(0.1, end - start));
    clip.name = content.replace(/\n/g, " ").slice(0, 40);
    clip.text = {
      ...clip.text!,
      ...textStyleFor(role, theme),
      content,
      fontSize: size,
      align: o.align ?? "left",
      lineHeight: o.lineHeight ?? theme.type.lineHeight,
      strokeWidth: 0,
      shadowBlur: 0,
      backgroundPadding: o.pad ?? 0,
      ...(o.weight ? { fontWeight: o.weight } : {}),
      ...(o.spacing !== undefined ? { letterSpacing: o.spacing } : {}),
    };
    clip.transform = { ...clip.transform, x: at.x / W, y: at.y / H };
    clip.textAnimation = o.anim ?? theme.motion.enter;
    clip.transitionOut = dissolve(theme.motion.exit);
    if (o.keyframes) clip.keyframes.push(...o.keyframes);
    return this.add(clip, role);
  }

  /**
   * A shape centred at (cx, cy), w by h project pixels. "grow" draws it from
   * its start along its direction; "flash" pops it in with a ring.
   */
  shape(
    role: ClipRole,
    kind: ShapeKind,
    box: { cx: number; cy: number; w: number; h: number; rotation?: number },
    start: number,
    end: number,
    enter: "rise" | "grow" | "pop" | "fade" | "flash" = "rise",
    extra: { name?: string; path?: string; opacity?: number } = {},
  ): Placed {
    const { theme, W, H, u } = this.f;
    const clip = shapeClip(start, Math.max(0.1, end - start));
    clip.name = extra.name ?? role;
    clip.shape = { ...clip.shape!, kind, fill: "rgba(0,0,0,0)", stroke: "rgba(0,0,0,0)", strokeWidth: 0, cornerRadius: 0, ...shapeStyleFor(role, theme), ...(extra.path ? { path: extra.path } : {}) };
    const scaleX = box.w / (W * 0.3);
    const scaleY = box.h / (H * 0.3);
    const rotation = box.rotation ?? 0;
    clip.transform = { ...clip.transform, x: box.cx / W, y: box.cy / H, scale: 1, scaleX, scaleY, rotation, ...(extra.opacity !== undefined ? { opacity: extra.opacity } : {}) };
    clip.transitionOut = dissolve(theme.motion.exit);
    if (enter === "grow") {
      const rad = (rotation * Math.PI) / 180;
      const sx = box.cx - (Math.cos(rad) * box.w) / 2;
      const sy = box.cy - (Math.sin(rad) * box.w) / 2;
      clip.keyframes.push(
        keyframe("transform.scaleX", 0, 0.001, "easeOut"),
        keyframe("transform.scaleX", 0.7, scaleX, "linear"),
        keyframe("transform.x", 0, sx / W, "easeOut"),
        keyframe("transform.x", 0.7, box.cx / W, "linear"),
      );
      if (Math.abs(Math.sin(rad)) > 1e-6) {
        clip.keyframes.push(keyframe("transform.y", 0, sy / H, "easeOut"), keyframe("transform.y", 0.7, box.cy / H, "linear"));
      }
    } else {
      clip.transitionIn = dissolve(0.4);
      if (enter === "rise") {
        clip.keyframes.push(keyframe("transform.y", 0, (box.cy + 24 * u) / H, "easeOut"), keyframe("transform.y", 0.5, box.cy / H, "linear"));
      } else if (enter === "pop" || enter === "flash") {
        clip.keyframes.push(keyframe("transform.scale", 0, 0.6, "easeOut"), keyframe("transform.scale", 0.45, 1, "linear"));
      }
    }
    const placed = this.add(clip, role);
    if (enter === "flash") this.flash(box, start + 0.15, kind === "ellipse" ? "ellipse" : "rectangle", clip.shape.cornerRadius);
    return placed;
  }

  /** A ring that grows out of a box and fades: on whatever just arrived or changed. */
  flash(box: { cx: number; cy: number; w: number; h: number }, at: number, kind: "ellipse" | "rectangle" = "ellipse", radius = 0): Placed {
    const { theme, W, H, u } = this.f;
    const clip = shapeClip(Math.max(0, at), FLASH);
    clip.name = "flash";
    clip.shape = { ...clip.shape!, kind, cornerRadius: radius, ...shapeStyleFor("flash", theme) };
    clip.transform = { ...clip.transform, x: box.cx / W, y: box.cy / H, scale: 1, scaleX: box.w / (W * 0.3), scaleY: box.h / (H * 0.3), opacity: 0.9 };
    // A node grows to 1.9×; a wide card by about the same margin, not to twice its width.
    const grow = 1 + 0.9 * Math.min(1, (140 * u) / Math.max(box.w, box.h, 1));
    clip.keyframes.push(
      keyframe("transform.scale", 0, 1, "easeOut"),
      keyframe("transform.scale", FLASH, grow, "linear"),
      keyframe("transform.opacity", 0, 0.9, "easeOut"),
      keyframe("transform.opacity", FLASH, 0, "linear"),
    );
    return this.add(clip, "flash");
  }

  result(bottom?: number): MacroResult {
    const limit = (REFERENCE_HEIGHT - 120) * this.f.u;
    if (bottom !== undefined && bottom > limit) {
      this.notes.push(`This scene now reaches y=${Math.round(bottom)} of ${this.f.H}: it is full. End it, or use fewer items.`);
    }
    return { clips: this.clips, ...(bottom !== undefined ? { bottom: Math.round(bottom) } : {}), notes: this.notes };
  }
}

function start(ctx: MacroContext, begin: number, end: number, y?: number) {
  if (!(end > begin)) throw new MacroError("end must be after the first entrance.");
  const f = frameOf(ctx);
  // The layout the scene settles into, not the one it starts in: a title that
  // arrives while the speaker is still moving into the panel must already fit
  // beside it. Where the two differ, the narrower wins.
  const early = zoneAt(f, begin);
  const settled = zoneAt(f, Math.min(end - 0.01, begin + f.theme.motion.move + 0.05));
  const zone: Zone = { x0: Math.max(early.x0, settled.x0), x1: Math.min(early.x1, settled.x1), full: early.full && settled.full };
  const speaker = speakerAt(f.project, begin);
  const firstVideo = f.project.tracks.findIndex((t) => t.kind === "video");
  const build = new Build(ctx, f, speaker?.trackIndex ?? firstVideo);
  const below = lowestEdge(f, zone, begin, end);
  const top = y !== undefined ? y * f.u : below !== null ? below + 40 * f.u : 300 * f.u;
  return { f, zone, build, top, below };
}

const fontOf = (theme: Theme, role: "display" | "body", weight: number, size: number, u: number, spacing = 0): Font => ({
  family: role === "display" ? theme.fonts.display : theme.fonts.body,
  weight,
  size: size * u,
  letterSpacing: spacing * u,
});

/* --------------------------------------------------------------- macros */

export const MOVED = ["transform.x", "transform.y", "transform.scale", "transform.crop.left", "transform.crop.right", "transform.radius"] as const;

export interface LayoutMoveArgs {
  at: number;
  to: "panel" | "full" | "pip";
  side?: "right" | "left";
  subjectX?: number;
  duration?: number;
  trackId?: string;
  clipId?: string;
}

/** Moves the speaker between full frame, a side panel and picture-in-picture, with keyframes. */
export function layoutMove(ctx: MacroContext, a: LayoutMoveArgs): MacroResult & { speaker: ClipRef; to: Record<string, number> } {
  const f = frameOf(ctx);
  const { project, theme, W, H, u } = f;
  let found: Speaker | null = null;
  if (a.trackId && a.clipId) {
    const track = project.tracks.find((t) => t.id === a.trackId);
    const clip = track?.clips.find((c) => c.id === a.clipId);
    if (track && clip) found = { track, trackIndex: project.tracks.indexOf(track), clip };
  } else found = speakerAt(project, a.at);
  if (!found) throw new MacroError("There is no video clip at that time to move. Put the speaker's clip on a video track, or pass trackId and clipId.");
  const { clip, track } = found;
  const asset = project.assets.find((x) => x.id === clip.assetId);
  if (!asset?.width || !asset.height) throw new MacroError("That clip's media has no picture size.");
  const local = a.at - clip.start;
  const now = (p: string) => valueAt(clip, p, local) ?? readProperty(clip, p) ?? 0;

  // Where the subject sits across the source: given, or the last panel's centre, or the middle.
  let subjectX = a.subjectX;
  if (subjectX === undefined) {
    const lefts = clip.keyframes.filter((k) => k.property === "transform.crop.left" && k.value > 0.05);
    const last = lefts[lefts.length - 1];
    const right = last ? valueAt(clip, "transform.crop.right", last.time) : undefined;
    subjectX = last && right !== undefined ? last.value + (1 - last.value - right) / 2 : 0.5;
  }

  const inset = theme.layout.panelInset * u;
  const right = (a.side ?? "right") === "right";
  let target: Record<(typeof MOVED)[number], number>;
  if (a.to === "full") {
    target = { "transform.x": 0.5, "transform.y": 0.5, "transform.scale": 1, "transform.crop.left": 0, "transform.crop.right": 0, "transform.radius": 0 };
  } else if (a.to === "panel") {
    const cardW = theme.layout.panelWidth * W - 2 * inset;
    const cardH = H - 2 * inset;
    const aspect = cardW / cardH;
    const visible = Math.min(1, (asset.height * aspect) / asset.width);
    let left = Math.min(Math.max(subjectX - visible / 2, 0), 1 - visible);
    let rightCrop = 1 - visible - left;
    // A crop takes at most 45% from an edge.
    if (left > 0.45) {
      rightCrop += left - 0.45;
      left = 0.45;
    }
    if (rightCrop > 0.45) {
      left += rightCrop - 0.45;
      rightCrop = 0.45;
    }
    target = {
      "transform.x": right ? (W - inset - cardW / 2) / W : (inset + cardW / 2) / W,
      "transform.y": 0.5,
      "transform.scale": cardH / H,
      "transform.crop.left": left,
      "transform.crop.right": rightCrop,
      "transform.radius": theme.layout.panelRadius,
    };
  } else {
    const pipW = 0.28 * W;
    const pipH = (pipW * asset.height) / asset.width;
    target = {
      "transform.x": right ? (W - inset - pipW / 2) / W : (inset + pipW / 2) / W,
      "transform.y": (H - inset - pipH / 2) / H,
      "transform.scale": Math.min(pipW / W, pipH / H),
      "transform.crop.left": 0,
      "transform.crop.right": 0,
      "transform.radius": theme.layout.panelRadius * 0.6,
    };
  }

  const duration = a.duration ?? theme.motion.move;
  const moved = new Set<string>(MOVED);
  const kept = clip.keyframes.filter((k) => !(moved.has(k.property) && k.time > local - 1e-3 && k.time < local + duration + 1e-3));
  const added = MOVED.flatMap((p) => [keyframe(p, local, now(p), "ease"), keyframe(p, local + duration, target[p], "linear")]);
  const ref = { trackId: track.id, clipId: clip.id };
  ctx.commit({ type: "patchClip", ref, patch: { role: "speaker", keyframes: [...kept, ...added] } });
  return {
    clips: [],
    notes: a.to === "panel" && a.subjectX === undefined && subjectX === 0.5 ? ["Centred on the middle of the source; pass subjectX (analyze_media finds it) if the subject sits elsewhere."] : [],
    speaker: ref,
    to: Object.fromEntries(Object.entries(target).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
  };
}

export interface TitleArgs {
  start: number;
  end: number;
  kicker?: string;
  title: string;
  subtitle?: string;
  footer?: string;
  y?: number;
}

/** A kicker, a title wrapped to the space, an optional subtitle and footer. */
export function addTitle(ctx: MacroContext, a: TitleArgs): MacroResult {
  const { f, zone, build, below } = start(ctx, a.start, a.end, a.y);
  const { theme, u } = f;
  const t = theme.type;
  const width = zone.x1 - zone.x0;
  let top = a.y !== undefined ? a.y * u : below !== null ? below + 40 * u : 214 * u;
  let at = a.start;
  if (a.kicker) {
    const content = t.kickerUppercase ? a.kicker.toUpperCase() : a.kicker;
    build.text("kicker", content, { x: zone.x0, y: top + (t.kicker * u) / 2 }, t.kicker, at, a.end, { anim: "fade", spacing: t.kickerSpacing });
    top += t.kicker * u + 18 * u;
    at += theme.motion.stagger;
  }
  const titleFont = fontOf(theme, "display", theme.weights.display, t.title, u);
  const lines = wrap(ctx, a.title, width, titleFont);
  const titleH = lines.length * t.title * u * t.lineHeight;
  build.text("title", lines.join("\n"), { x: zone.x0, y: top + titleH / 2 }, t.title, at, a.end);
  top += titleH;
  if (a.subtitle) {
    top += 14 * u;
    const sub = wrap(ctx, a.subtitle, width, fontOf(theme, "body", theme.weights.body, t.body, u));
    const subH = sub.length * t.body * u * 1.3;
    build.text("muted", sub.join("\n"), { x: zone.x0, y: top + subH / 2 }, t.body, at + theme.motion.stagger, a.end, { anim: "fade", lineHeight: 1.3 });
    top += subH;
  }
  if (a.footer) {
    build.text("footer", a.footer.toUpperCase(), { x: zone.x0, y: 1012 * u }, 16, a.start, a.end, { anim: "fade", spacing: 3 });
  }
  return build.result(top);
}

export interface PointsArgs {
  end: number;
  items: { at: number; text: string; icon?: "check" | "cross" | "dot" | "number" | "none"; lead?: string }[];
  y?: number;
  size?: number;
}

/** A list, one row per item, each arriving on its word. */
export function addPoints(ctx: MacroContext, a: PointsArgs): MacroResult {
  const first = Math.min(...a.items.map((i) => i.at));
  const { f, zone, build, top: y0 } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const size = a.size ?? theme.type.body;
  const font = fontOf(theme, "body", theme.weights.body, size, u);
  const leadFont = fontOf(theme, "body", 700, size, u);
  const leadCol = a.items.some((i) => i.lead) ? Math.max(...a.items.map((i) => (i.lead ? ctx.measure(i.lead, leadFont) : 0))) + 28 * u : 0;
  let top = y0;
  a.items.forEach((item, i) => {
    const icon = item.icon ?? (leadCol ? "none" : "dot");
    const iconCol = icon === "none" ? 0 : size * u * 1.7;
    const column = iconCol + leadCol;
    if (item.lead) build.text("label-accent", item.lead, { x: zone.x0 + iconCol, y: top + (size * u * 1.25) / 2 }, size, item.at, a.end, { anim: "fade" });
    const lines = wrap(ctx, item.text, zone.x1 - zone.x0 - column, font);
    const h = lines.length * size * u * 1.25;
    const cy = top + h / 2;
    const firstLine = top + (size * u * 1.25) / 2;
    if (icon === "check") build.text("icon-positive", "✓", { x: zone.x0, y: firstLine }, size, item.at, a.end, { anim: "pop", weight: 700 });
    else if (icon === "cross") build.text("icon-negative", "✕", { x: zone.x0, y: firstLine }, size, item.at, a.end, { anim: "pop", weight: 700 });
    else if (icon === "dot") build.text("label-accent", "●", { x: zone.x0 + 4 * u, y: firstLine }, size * 0.5, item.at, a.end, { anim: "pop" });
    else if (icon === "number") {
      build.text("number", String(i + 1), { x: zone.x0 + (size * u * 0.6) / 2, y: firstLine }, size * 0.78, item.at, a.end, { anim: "pop", pad: 9, align: "center" });
    }
    build.text("body", lines.join("\n"), { x: zone.x0 + column, y: cy }, size, item.at + 0.1, a.end, { anim: "fade", lineHeight: 1.25 });
    top += h + size * u * 0.75;
  });
  return build.result(top);
}

export interface ChipsArgs {
  end: number;
  items: { at: number; text: string; tone?: "accent" | "positive" | "neutral" }[];
  y?: number;
  size?: number;
}

/** Pills in a row, wrapping to the next when the space runs out, each measured in the theme's face. */
export function addChips(ctx: MacroContext, a: ChipsArgs): MacroResult {
  const first = Math.min(...a.items.map((i) => i.at));
  const { f, zone, build, top } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const size = a.size ?? Math.round(theme.type.body * 0.93);
  const pad = 14;
  const font = fontOf(theme, "body", 600, size, u);
  const rowH = size * u * theme.type.lineHeight + 2 * pad * u + 16 * u;
  let x = zone.x0;
  let row = 0;
  for (const item of a.items) {
    const w = ctx.measure(item.text, font) + 2 * pad * u;
    if (x > zone.x0 && x + w > zone.x1) {
      row += 1;
      x = zone.x0;
    }
    const role: ClipRole = item.tone === "positive" ? "chip-positive" : item.tone === "neutral" ? "chip-neutral" : "chip";
    build.text(role, item.text, { x: x + pad * u, y: top + pad * u + (size * u * theme.type.lineHeight) / 2 + row * rowH }, size, item.at, a.end, { anim: "pop", pad });
    x += w + 16 * u;
  }
  return build.result(top + (row + 1) * rowH);
}

export interface StatArgs {
  start: number;
  end: number;
  value: string;
  label?: string;
  y?: number;
}

/** One number, large, with what it means beside or under it. */
export function addStat(ctx: MacroContext, a: StatArgs): MacroResult {
  const { f, zone, build, top } = start(ctx, a.start, a.end, a.y);
  const { theme, u } = f;
  const t = theme.type;
  const valueFont = fontOf(theme, "display", theme.weights.stat, t.stat, u);
  const valueW = ctx.measure(a.value, valueFont);
  const valueH = t.stat * u * 1.05;
  build.text("stat", a.value, { x: zone.x0, y: top + valueH / 2 }, t.stat, a.start, a.end, { anim: "pop", lineHeight: 1.05 });
  let bottom = top + valueH;
  if (a.label) {
    const labelFont = fontOf(theme, "body", 700, t.subtitle, u);
    const room = zone.x1 - zone.x0 - valueW - 40 * u;
    if (ctx.measure(a.label, labelFont) <= room) {
      build.text("subtitle", a.label, { x: zone.x0 + valueW + 40 * u, y: top + valueH * 0.55 }, t.subtitle, a.start + theme.motion.stagger * 3, a.end, { anim: "fade" });
    } else {
      const lines = wrap(ctx, a.label, zone.x1 - zone.x0, labelFont);
      const h = lines.length * t.subtitle * u * 1.2;
      build.text("subtitle", lines.join("\n"), { x: zone.x0, y: bottom + 10 * u + h / 2 }, t.subtitle, a.start + theme.motion.stagger * 3, a.end, { anim: "fade", lineHeight: 1.2 });
      bottom += 10 * u + h;
    }
  }
  return build.result(bottom);
}

export interface FlowArgs {
  end: number;
  steps: { at: number; text: string; style?: "box" | "pill" }[];
  y?: number;
  highlight?: "last" | "none";
}

/** Boxes left to right with arrows between, each arriving on its word; the last highlighted. */
export function addFlow(ctx: MacroContext, a: FlowArgs): MacroResult {
  const first = Math.min(...a.steps.map((s) => s.at));
  const { f, zone, build, top } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const n = a.steps.length;
  const gap = 110 * u;
  const boxW = (zone.x1 - zone.x0 - (n - 1) * gap) / n;
  const size = Math.round(theme.type.body * 0.95);
  const font = fontOf(theme, "body", 700, size, u);
  const wrapped = a.steps.map((s) => wrap(ctx, s.text, boxW - 44 * u, font));
  const boxH = Math.max(130 * u, Math.max(...wrapped.map((l) => l.length)) * size * u * 1.25 + 64 * u);
  const cy = top + boxH / 2;
  a.steps.forEach((step, i) => {
    const cx = zone.x0 + boxW / 2 + i * (boxW + gap);
    const lit = (a.highlight ?? "last") === "last" && i === n - 1;
    if (step.style === "pill") {
      build.text("chip", step.text, { x: cx, y: cy }, Math.round(size * 1.15), step.at, a.end, { align: "center", anim: "pop", pad: 16 });
    } else {
      build.shape(lit ? "card-accent" : "card", "rectangle", { cx, cy, w: boxW, h: boxH }, step.at, a.end, "rise");
      build.text(lit ? "label-accent" : "label", wrapped[i]!.join("\n"), { x: cx, y: cy }, size, step.at + 0.15, a.end, { align: "center", anim: "fade", lineHeight: 1.25 });
    }
    if (i < n - 1) {
      const next = a.steps[i + 1]!;
      build.shape("arrow", "arrow", { cx: cx + boxW / 2 + gap / 2, cy, w: 60 * u, h: 36 * u }, Math.max(step.at, next.at - 0.35), a.end, "grow");
    }
  });
  return build.result(top + boxH);
}

export interface BarsArgs {
  end: number;
  items: { at: number; label: string; value: number; display?: string }[];
  orientation?: "horizontal" | "vertical";
  scale?: "linear" | "log";
  highlight?: "last" | "max" | "none";
  y?: number;
  height?: number;
}

/** A bar per item, growing on its word — horizontal with labels, or vertical like a ladder. */
export function addBars(ctx: MacroContext, a: BarsArgs): MacroResult {
  const first = Math.min(...a.items.map((i) => i.at));
  const { f, zone, build, top } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const values = a.items.map((i) => i.value);
  if (values.some((v) => !(v > 0)) && a.scale === "log") throw new MacroError("A log scale needs every value above zero.");
  const max = Math.max(...values);
  const min = Math.min(...values);
  const norm = (v: number) =>
    a.scale === "log" ? (max === min ? 1 : (Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) : max > 0 ? v / max : 0;
  const lit = (i: number) => {
    const mode = a.highlight ?? "last";
    return mode === "last" ? i === a.items.length - 1 : mode === "max" ? values[i] === max : false;
  };
  const shown = a.items.map((i) => i.display ?? i.value.toLocaleString("en-US"));
  const size = Math.round(theme.type.body * 0.9);

  if ((a.orientation ?? "horizontal") === "horizontal") {
    const labelFont = fontOf(theme, "body", theme.weights.body, size, u);
    const valueFont = fontOf(theme, "body", 700, size, u);
    const labelCol = Math.max(...a.items.map((i) => ctx.measure(i.label, labelFont))) + 28 * u;
    const valueCol = Math.max(...shown.map((s) => ctx.measure(s, valueFont))) + 28 * u;
    const x0 = zone.x0 + labelCol;
    const room = zone.x1 - x0 - valueCol;
    const rowH = 78 * u;
    a.items.forEach((item, i) => {
      const cy = top + rowH / 2 + i * rowH;
      const w = Math.max(10 * u, (a.scale === "log" ? 0.12 + 0.88 * norm(item.value) : norm(item.value)) * room);
      build.text("muted", item.label, { x: zone.x0, y: cy }, size, item.at, a.end, { anim: "fade" });
      build.shape(lit(i) ? "bar-accent" : "bar", "rectangle", { cx: x0 + w / 2, cy, w, h: 44 * u }, item.at, a.end, "grow");
      build.text(lit(i) ? "label-accent" : "label", shown[i]!, { x: x0 + w + 20 * u, y: cy }, size, item.at + 0.4, a.end, { anim: "fade" });
    });
    return build.result(top + a.items.length * rowH);
  }

  const area = (a.height ?? 420) * u;
  const base = top + area;
  const spacing = (zone.x1 - zone.x0) / a.items.length;
  const barW = Math.min(84 * u, spacing * 0.62);
  a.items.forEach((item, i) => {
    const cx = zone.x0 + spacing * (i + 0.5);
    const len = Math.max(12 * u, (a.scale === "log" ? 0.08 + 0.92 * norm(item.value) : norm(item.value)) * area);
    build.shape(lit(i) ? "bar-accent" : "bar", "rectangle", { cx, cy: base - len / 2, w: len, h: barW, rotation: -90 }, item.at, a.end, "grow");
  });
  a.items.forEach((item, i) => {
    const cx = zone.x0 + spacing * (i + 0.5);
    build.text(lit(i) ? "label-accent" : "label", `${item.label}\n${shown[i]}`, { x: cx, y: base + 20 * u + size * u * 1.2 }, Math.round(size * 0.85), item.at + 0.2, a.end, {
      align: "center",
      anim: "fade",
      lineHeight: 1.2,
    });
  });
  return build.result(base + 20 * u + size * u * 2.6);
}

export interface LowerThirdArgs {
  start: number;
  end: number;
  name: string;
  role?: string;
}

/** A name and a role on a plate at the bottom of the graphics' space. */
export function addLowerThird(ctx: MacroContext, a: LowerThirdArgs): MacroResult {
  const { f, zone, build } = start(ctx, a.start, a.end);
  const { theme, u, H } = f;
  const nameSize = Math.round(theme.type.subtitle * 1.1);
  const roleSize = Math.round(theme.type.body * 0.8);
  const pad = 26 * u;
  const nameW = ctx.measure(a.name, fontOf(theme, "display", theme.weights.display, nameSize, u));
  const roleW = a.role ? ctx.measure(a.role, fontOf(theme, "body", theme.weights.body, roleSize, u)) : 0;
  const w = Math.max(nameW, roleW) + 2 * pad;
  const h = nameSize * u * 1.2 + (a.role ? roleSize * u * 1.3 : 0) + 2 * pad * 0.8;
  const bottom = H - 90 * u;
  const cy = bottom - h / 2;
  const x0 = zone.x0;
  build.shape("lower-third-plate", "rectangle", { cx: x0 + w / 2, cy, w, h }, a.start, a.end, "grow");
  const nameY = bottom - h + pad * 0.8 + (nameSize * u * 1.2) / 2;
  build.text("lower-third-name", a.name, { x: x0 + pad, y: nameY }, nameSize, a.start + 0.3, a.end, { anim: "slideLeft" });
  if (a.role) build.text("lower-third-role", a.role, { x: x0 + pad, y: nameY + (nameSize * u * 1.2) / 2 + (roleSize * u * 1.3) / 2 }, roleSize, a.start + 0.45, a.end, { anim: "slideLeft" });
  return build.result();
}

export interface BackdropArgs {
  start: number;
  end: number;
  opacity?: number;
}

/** A plate over the whole frame, in the theme's background, for graphics that cut away from full-frame video. */
export function addBackdrop(ctx: MacroContext, a: BackdropArgs): MacroResult {
  const { f, build } = start(ctx, a.start, a.end);
  const placed = build.shape("scrim", "rectangle", { cx: f.W / 2, cy: f.H / 2, w: f.W, h: f.H }, a.start, a.end, "fade");
  if (a.opacity !== undefined) {
    const clip = f.project.tracks.flatMap((t) => t.clips).find((c) => c.id === placed.clipId);
    void clip;
    ctx.commit({ type: "setTransform", ref: { trackId: placed.trackId, clipId: placed.clipId }, patch: { opacity: Math.max(0, Math.min(1, a.opacity)) } });
  }
  return build.result();
}

export interface StatementArgs {
  end: number;
  lines: { at: number; text: string; tone?: "text" | "accent" | "muted" }[];
  size?: "hero" | "stat" | "title";
  y?: number;
}

/** A few words, very large: a term being named ("Spillover"), a sum ("6 × 100 = 600"), a verdict. */
export function addStatement(ctx: MacroContext, a: StatementArgs): MacroResult {
  const first = Math.min(...a.lines.map((l) => l.at));
  const { f, zone, build, top: y0 } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const t = theme.type;
  const size = a.size === "stat" ? t.stat : a.size === "title" ? Math.round(t.title * 1.3) : Math.round(t.stat * 0.78);
  let top = y0;
  for (const line of a.lines) {
    const role: ClipRole = line.tone === "muted" ? "muted" : line.tone === "accent" ? "stat" : "title";
    const weight = role === "muted" ? theme.weights.body : role === "stat" ? theme.weights.stat : theme.weights.display;
    const lines = wrap(ctx, line.text, zone.x1 - zone.x0, fontOf(theme, role === "muted" ? "body" : "display", weight, size, u));
    const h = lines.length * size * u * 1.08;
    build.text(role, lines.join("\n"), { x: zone.x0, y: top + h / 2 }, size, line.at, a.end, { anim: "pop", lineHeight: 1.08, weight });
    top += h + 8 * u;
  }
  return build.result(top);
}

export interface TallyArgs {
  end: number;
  items: { at: number; label: string; count: number; value: string }[];
  y?: number;
}

/** Rows of dots that show a count doubling or growing, with the number beside each. */
export function addTally(ctx: MacroContext, a: TallyArgs): MacroResult {
  const first = Math.min(...a.items.map((i) => i.at));
  const { f, zone, build, top } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const size = theme.type.body;
  const labelFont = fontOf(theme, "body", theme.weights.body, size, u);
  const dotFont = fontOf(theme, "body", 500, Math.round(size * 0.8), u, 10);
  const dots = (n: number) => "●".repeat(Math.min(Math.max(0, Math.round(n)), 24)) + (n > 24 ? " …" : "");
  const labelCol = Math.max(...a.items.map((i) => ctx.measure(i.label, labelFont))) + 36 * u;
  const dotCol = Math.max(...a.items.map((i) => ctx.measure(dots(i.count), dotFont))) + 40 * u;
  const rowH = size * u * 2.1;
  a.items.forEach((item, i) => {
    const cy = top + rowH / 2 + i * rowH;
    build.text("muted", item.label, { x: zone.x0, y: cy }, size, item.at, a.end, { anim: "fade" });
    build.text("label-accent", dots(item.count), { x: zone.x0 + labelCol, y: cy }, Math.round(size * 0.8), item.at + 0.1, a.end, { anim: "fade", spacing: 10, weight: 500 });
    build.text("label", item.value, { x: zone.x0 + labelCol + dotCol, y: cy }, size, item.at + 0.25, a.end, { anim: "fade" });
  });
  return build.result(top + a.items.length * rowH);
}

export interface CardsArgs {
  end: number;
  cards: { at: number; kicker?: string; title: string; body?: string }[];
  highlight?: "last" | "first" | "none";
  y?: number;
}

/** Two to four cards side by side — options, halves of a system, a comparison. */
export function addCards(ctx: MacroContext, a: CardsArgs): MacroResult {
  const first = Math.min(...a.cards.map((c) => c.at));
  const { f, zone, build, top } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const t = theme.type;
  const n = a.cards.length;
  const gap = 40 * u;
  const cardW = (zone.x1 - zone.x0 - gap * (n - 1)) / n;
  const pad = 36 * u;
  const titleSize = Math.round(t.subtitle * 1.25);
  const bodySize = Math.round(t.body * 0.9);
  const titleFont = fontOf(theme, "display", theme.weights.display, titleSize, u);
  const bodyFont = fontOf(theme, "body", theme.weights.body, bodySize, u);
  const laid = a.cards.map((c) => ({
    title: wrap(ctx, c.title, cardW - 2 * pad, titleFont),
    body: c.body ? wrap(ctx, c.body, cardW - 2 * pad, bodyFont) : [],
  }));
  const kickerH = a.cards.some((c) => c.kicker) ? t.kicker * u + 16 * u : 0;
  const cardH = pad * 2 + kickerH + Math.max(...laid.map((l) => l.title.length * titleSize * u * 1.15 + (l.body.length ? 16 * u + l.body.length * bodySize * u * 1.3 : 0)));
  a.cards.forEach((card, i) => {
    const x0 = zone.x0 + i * (cardW + gap);
    const lit = (a.highlight ?? "none") === "last" ? i === n - 1 : a.highlight === "first" ? i === 0 : false;
    build.shape(lit ? "card-accent" : "card", "rectangle", { cx: x0 + cardW / 2, cy: top + cardH / 2, w: cardW, h: cardH }, card.at, a.end, "rise");
    let y = top + pad;
    if (card.kicker) {
      build.text("kicker", t.kickerUppercase ? card.kicker.toUpperCase() : card.kicker, { x: x0 + pad, y: y + (t.kicker * u) / 2 }, t.kicker, card.at + 0.15, a.end, { anim: "fade", spacing: t.kickerSpacing });
    }
    y += kickerH;
    const titleH = laid[i]!.title.length * titleSize * u * 1.15;
    build.text(lit ? "label-accent" : "title", laid[i]!.title.join("\n"), { x: x0 + pad, y: y + titleH / 2 }, titleSize, card.at + 0.25, a.end, { anim: "fade", lineHeight: 1.15, weight: theme.weights.display });
    y += titleH + 16 * u;
    if (laid[i]!.body.length) {
      const bodyH = laid[i]!.body.length * bodySize * u * 1.3;
      build.text("muted", laid[i]!.body.join("\n"), { x: x0 + pad, y: y + bodyH / 2 }, bodySize, card.at + 0.4, a.end, { anim: "fade", lineHeight: 1.3 });
    }
  });
  return build.result(top + cardH);
}

export interface SplitArgs {
  end: number;
  source: { at: number; text: string };
  branches: { at: number; title: string; body?: string }[];
  y?: number;
}

/** One thing dividing into two or three — a payment split in half, a choice. */
export function addSplit(ctx: MacroContext, a: SplitArgs): MacroResult {
  const { f, zone, build, top } = start(ctx, a.source.at, a.end, a.y);
  const { theme, u } = f;
  const size = Math.round(theme.type.body);
  const srcW = Math.min(420 * u, zone.x1 - zone.x0);
  const srcH = 100 * u;
  const cx = (zone.x0 + zone.x1) / 2;
  build.shape("card-accent", "rectangle", { cx, cy: top + srcH / 2, w: srcW, h: srcH }, a.source.at, a.end, "rise");
  build.text("label-accent", a.source.text, { x: cx, y: top + srcH / 2 }, size, a.source.at + 0.15, a.end, { align: "center", anim: "fade" });
  const cardsTop = top + srcH + 110 * u;
  const n = a.branches.length;
  const gap = 60 * u;
  const cardW = (zone.x1 - zone.x0 - gap * (n - 1)) / n;
  const result = addCards(
    { ...ctx },
    { end: a.end, cards: a.branches.map((b) => ({ at: b.at, title: b.title, ...(b.body ? { body: b.body } : {}) })), y: cardsTop / u },
  );
  a.branches.forEach((b, i) => {
    const bx = zone.x0 + cardW / 2 + i * (cardW + gap);
    build.shape("connector-accent", "line", lineBox(cx, top + srcH, bx, cardsTop), Math.max(a.source.at, b.at - 0.4), a.end, "grow");
  });
  return { clips: [...build.clips, ...result.clips], bottom: result.bottom ?? Math.round(cardsTop), notes: [...build.notes, ...result.notes] };
}

/** Where a line between two circles leaves the first's rim and meets the second's. */
function rims(x1: number, y1: number, x2: number, y2: number, r1 = 0, r2 = 0) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  return { ax: x1 + ux * r1, ay: y1 + uy * r1, bx: x2 - ux * r2, by: y2 - uy * r2 };
}

/** A line from one point to another, as a shape box: a line is drawn along its width, then rotated. */
function lineBox(x1: number, y1: number, x2: number, y2: number, r1 = 0, r2 = 0) {
  const { ax, ay, bx, by } = rims(x1, y1, x2, y2, r1, r2);
  return { cx: (ax + bx) / 2, cy: (ay + by) / 2, w: Math.max(1, Math.hypot(bx - ax, by - ay)), h: 4, rotation: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI };
}

export interface TreeArgs {
  end: number;
  nodes: { id: string; label: string; parent?: string | null; at: number; tone?: "accent" | "positive" | "neutral"; note?: string; flash?: boolean }[];
  moves?: { node: string; parent: string; at: number; flash?: boolean }[];
  y?: number;
  size?: number;
  /** Draw the empty seats and edges faintly, this many levels below the root. */
  ghost?: number;
}

type Seats = Map<string, { x: number; y: number; depth: number }>;

/**
 * The seats of a complete tree as deep as `ghost` asks, with as many children
 * to a node as the busiest node has: where each node sits — its parent's seat,
 * by its place among the children — and one faint path holding every seat and
 * edge, so the rest of the matrix is one clip however many seats it has.
 */
function ghostSeats(a: TreeArgs, parents: Map<string, string | null>, zone: Zone, top: number, gapY: number, size: number, u: number) {
  const roots = a.nodes.filter((n) => !parents.get(n.id));
  if (roots.length !== 1) throw new MacroError("ghost draws the rest of one tree: give the tree exactly one root.");
  const kids = (map: Map<string, string | null>, id: string) => a.nodes.filter((n) => map.get(n.id) === id).map((n) => n.id);
  const depthOf = (id: string): number => {
    const parent = parents.get(id);
    return parent ? depthOf(parent) + 1 : 0;
  };
  const branching = Math.max(2, ...a.nodes.map((n) => kids(parents, n.id).length));
  const levels = Math.max(a.ghost ?? 0, ...a.nodes.map((n) => depthOf(n.id)));
  const seats = (branching ** (levels + 1) - 1) / (branching - 1);
  if (seats > 121) throw new MacroError(`A ${branching}-way tree ${levels} levels deep has ${seats} seats, too many to read. Use a smaller ghost.`);
  const notes: string[] = [];
  const width = zone.x1 - zone.x0;
  let d = size;
  const narrowest = width / branching ** levels;
  if (d > narrowest * 0.8) {
    d = Math.max(28 * u, narrowest * 0.8);
    notes.push(`Nodes are ${Math.round(d / u)} px across so ${branching ** levels} seats fit along the bottom row.`);
  }
  const seatX = (level: number, seat: number) => zone.x0 + ((seat + 0.5) * width) / branching ** level;
  const seatY = (level: number) => top + d / 2 + level * gapY;
  const radius = (level: number) => (level === 0 ? d * 1.15 : d) / 2;
  const layout = (map: Map<string, string | null>): Seats => {
    const pos: Seats = new Map();
    const place = (id: string, level: number, seat: number) => {
      pos.set(id, { x: seatX(level, seat), y: seatY(level), depth: level });
      kids(map, id).forEach((k, i) => place(k, level + 1, seat * branching + i));
    };
    for (const n of a.nodes) if (map.has(n.id) && !map.get(n.id)) place(n.id, 0, 0);
    return pos;
  };
  // The path is written in its own box, 0..1 each way; an arc's radii too, so a seat stays round.
  const bh = levels * gapY + 2 * radius(0);
  const by0 = seatY(0) - radius(0);
  const X = (x: number) => ((x - zone.x0) / width).toFixed(5);
  const Y = (y: number) => ((y - by0) / bh).toFixed(5);
  const parts: string[] = [];
  for (let level = 0; level <= levels; level += 1) {
    for (let seat = 0; seat < branching ** level; seat += 1) {
      const x = seatX(level, seat);
      const y = seatY(level);
      const r = radius(level);
      const rx = (r / width).toFixed(5);
      const ry = (r / bh).toFixed(5);
      parts.push(`M${X(x + r)} ${Y(y)}A${rx} ${ry} 0 1 0 ${X(x - r)} ${Y(y)}A${rx} ${ry} 0 1 0 ${X(x + r)} ${Y(y)}`);
      if (level > 0) {
        const e = rims(seatX(level - 1, Math.floor(seat / branching)), seatY(level - 1), x, y, radius(level - 1), r);
        parts.push(`M${X(e.ax)} ${Y(e.ay)}L${X(e.bx)} ${Y(e.by)}`);
      }
    }
  }
  return { d, levels, notes, layout, path: parts.join(""), box: { cx: zone.x0 + width / 2, cy: by0 + bh / 2, w: width, h: bh } };
}

/**
 * A tree of nodes — a referral matrix, seats under a member — drawn level by
 * level, each node arriving on its word. A move carries a node from where it
 * arrived to a new parent: the TreeFlux spill, where a third referral drops
 * to the first empty seat below.
 */
export function addTree(ctx: MacroContext, a: TreeArgs): MacroResult {
  const first = Math.min(...a.nodes.map((n) => n.at));
  const { f, zone, build, top } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const ids = new Set(a.nodes.map((n) => n.id));
  if (ids.size !== a.nodes.length) throw new MacroError("Every tree node needs its own id.");
  for (const n of a.nodes) if (n.parent && !ids.has(n.parent)) throw new MacroError(`Node ${n.id} names a parent ${n.parent} that is not in the tree.`);
  for (const m of a.moves ?? []) if (!ids.has(m.node) || !ids.has(m.parent)) throw new MacroError(`A move names a node that is not in the tree: ${m.node} → ${m.parent}.`);

  let d = (a.size ?? 96) * u;
  const gapY = 190 * u;
  const initialParents = new Map(a.nodes.map((n) => [n.id, n.parent ?? null] as const));
  const finalParents = new Map(initialParents);
  for (const m of a.moves ?? []) finalParents.set(m.node, m.parent);
  const ghost = a.ghost ? ghostSeats(a, finalParents, zone, top, gapY, d, u) : null;
  if (ghost) {
    d = ghost.d;
    build.notes.push(...ghost.notes);
  }
  const layout = ghost ? ghost.layout : (parents: Map<string, string | null>): Seats => {
    const children = new Map<string | null, string[]>();
    for (const n of a.nodes) {
      const p = parents.get(n.id) ?? null;
      children.set(p, [...(children.get(p) ?? []), n.id]);
    }
    const leaves = (id: string): number => {
      const kids = children.get(id) ?? [];
      return kids.length ? kids.reduce((s, k) => s + leaves(k), 0) : 1;
    };
    const roots = children.get(null) ?? [];
    const total = roots.reduce((s, r) => s + leaves(r), 0);
    const pos = new Map<string, { x: number; y: number; depth: number }>();
    const place = (id: string, x0: number, x1: number, depth: number) => {
      pos.set(id, { x: (x0 + x1) / 2, y: top + d / 2 + depth * gapY, depth });
      const kids = children.get(id) ?? [];
      let cursor = x0;
      for (const k of kids) {
        const w = ((x1 - x0) * leaves(k)) / Math.max(1, leaves(id));
        place(k, cursor, cursor + w, depth + 1);
        cursor += w;
      }
    };
    let cursor = zone.x0;
    for (const r of roots) {
      const w = ((zone.x1 - zone.x0) * leaves(r)) / Math.max(1, total);
      place(r, cursor, cursor + w, 0);
      cursor += w;
    }
    return pos;
  };

  const moving = new Map((a.moves ?? []).map((m) => [m.node, m] as const));
  // Stable layout without the movers, then the movers: where they arrive (beside
  // the first root when they come in unattached) and where they end up.
  const settled = layout(finalParents);
  const withoutMovers = new Map([...initialParents].map(([k, v]) => [k, moving.has(k) ? "__floating__" : v] as const));
  const base = layout(new Map([...withoutMovers].filter(([, v]) => v !== "__floating__")));
  const root = [...base.values()].find((p) => p.depth === 0);
  const start0 = (id: string) => {
    const parent = initialParents.get(id);
    if (parent && base.get(parent)) {
      const p = base.get(parent)!;
      return { x: p.x + (settled.get(id)!.x - settled.get(finalParents.get(id)!)!.x), y: p.y + gapY };
    }
    return { x: Math.min(zone.x1 - d, (root?.x ?? zone.x0) + 3.4 * d), y: root?.y ?? top + d / 2 };
  };
  const positionOf = (id: string) => (moving.has(id) ? start0(id) : settled.get(id)!);
  const MOVE = 1.8;

  if (ghost) build.shape("ghost", "path", ghost.box, first, a.end, "fade", { path: ghost.path, opacity: 0.7, name: "empty seats" });

  // Connectors first, so the nodes cover their ends.
  for (const n of a.nodes) {
    const parent = finalParents.get(n.id);
    if (!parent) continue;
    const p = settled.get(parent)!;
    const c = settled.get(n.id)!;
    const move = moving.get(n.id);
    const at = move ? move.at + MOVE : n.at - 0.2;
    build.shape(n.tone === "accent" ? "connector-accent" : "connector", "line", lineBox(p.x, p.y, c.x, c.y, d / 2, d / 2), Math.max(0, at), a.end, "grow");
  }
  for (const n of a.nodes) {
    const from = positionOf(n.id);
    const to = settled.get(n.id)!;
    const move = moving.get(n.id);
    const isRoot = !finalParents.get(n.id) && settled.get(n.id)!.depth === 0;
    const tone = n.tone ?? (isRoot ? "accent" : "neutral");
    const size = isRoot ? d * 1.15 : d;
    const nodeRole: ClipRole = tone === "accent" ? "node-accent" : tone === "positive" ? "node-positive" : "node";
    const textRole: ClipRole = tone === "accent" ? "label-accent" : tone === "positive" ? "label-positive" : "label";
    const placed = [
      // Named for its id, so add_flash and add_coin can find it.
      build.shape(nodeRole, "ellipse", { cx: from.x, cy: from.y, w: size, h: size }, n.at, a.end, n.flash ? "flash" : "pop", { name: `node ${n.id}` }),
      build.text(textRole, n.label, { x: from.x, y: from.y }, Math.round(theme.type.body * 0.9), n.at + 0.1, a.end, { align: "center", anim: "fade" }),
      ...(n.note ? [build.text("muted", n.note, { x: from.x, y: from.y + size / 2 + 30 * u }, Math.round(theme.type.body * 0.8), n.at + 0.3, a.end, { align: "center", anim: "fade" })] : []),
    ];
    if (move) {
      const project = ctx.project();
      for (const p of placed) {
        const clip = project.tracks.find((t) => t.id === p.trackId)?.clips.find((c) => c.id === p.clipId);
        if (!clip) continue;
        const dy = (clip.transform.y * f.H) - from.y;
        const local = (t: number) => Math.max(0, t - clip.start);
        const keys = clip.keyframes.filter((k) => k.property !== "transform.x" && k.property !== "transform.y");
        keys.push(
          keyframe("transform.x", local(move.at), from.x / f.W, "ease"),
          keyframe("transform.x", local(move.at + MOVE), to.x / f.W, "linear"),
          keyframe("transform.y", local(move.at), (from.y + dy) / f.H, "ease"),
          keyframe("transform.y", local(move.at + MOVE), (to.y + dy) / f.H, "linear"),
        );
        ctx.commit({ type: "patchClip", ref: { trackId: p.trackId, clipId: p.clipId }, patch: { keyframes: keys } });
      }
      if (move.flash) build.flash({ cx: to.x, cy: to.y, w: size, h: size }, move.at + MOVE);
    }
  }
  const depth = Math.max(ghost?.levels ?? 0, ...[...settled.values()].map((p) => p.depth));
  return build.result(top + depth * gapY + d + (a.nodes.some((n) => n.note) ? 60 * u : 0));
}

export interface FooterArgs {
  start: number;
  end: number;
  text: string;
}

/** A small line at the foot of the graphics' space: the video's name, a source. */
export function addFooter(ctx: MacroContext, a: FooterArgs): MacroResult {
  const { f, zone, build } = start(ctx, a.start, a.end);
  build.text("footer", a.text.toUpperCase(), { x: zone.x0, y: (REFERENCE_HEIGHT - 68) * f.u }, 16, a.start, a.end, { anim: "fade", spacing: 3 });
  return build.result();
}

/* ------------------------------------------------ tables, stacks, motion */

/** Seconds a line of a table or a stack takes to arrive. */
const REVEAL = 0.4;

/** Row height of a table, in lines of its type. */
const ROW = 1.75;

/** Times made to run down the page: an item never arrives before the one above it. */
function inOrder(times: number[]): { times: number[]; late: boolean } {
  let floor = Number.NEGATIVE_INFINITY;
  let late = false;
  const ordered = times.map((t) => {
    if (t < floor - 0.01) late = true;
    floor = Math.max(floor, t);
    return floor;
  });
  return { times: ordered, late };
}

/**
 * `text.reveal` keys that bring a block's lines in at their times, seconds
 * into a clip that starts at `start`. Lines arriving together stagger, one
 * waits for the one before it to land, and once the last has landed every
 * line shows — so a line added by hand later is not hidden for good.
 */
function revealKeys(times: number[], start: number): Keyframe[] {
  const keys: Keyframe[] = [];
  let shown = 0;
  let free = start;
  for (let i = 0; i < times.length; ) {
    let together = 1;
    while (i + together < times.length && Math.abs(times[i + together]! - times[i]!) < 0.05) together += 1;
    const at = Math.max(times[i]!, free);
    const span = Math.min(1.2, REVEAL + 0.12 * (together - 1));
    keys.push(keyframe("text.reveal", at - start, shown, "easeOut"));
    shown += together;
    keys.push(keyframe("text.reveal", at - start + span, shown, "hold"));
    free = at + span;
    i += together;
  }
  keys.push(keyframe("text.reveal", free - start + 0.01, 999, "hold"));
  return keys;
}

export interface TableArgs {
  end: number;
  columns: { header?: string; align?: "left" | "center" | "right" }[];
  rows: { at: number; cells: (string | { text: string; at: number })[] }[];
  highlight?: number[];
  y?: number;
  size?: number;
}

/**
 * A table: a header over each column, rows arriving on their words, and a
 * cell with its own time arriving then — a column that fills in later. Each
 * column is one clip whose lines `text.reveal` brings in, so a 9 × 3 table
 * takes seven tracks where a clip per cell took thirty-seven.
 */
export function addTable(ctx: MacroContext, a: TableArgs): MacroResult {
  const n = a.columns.length;
  if (a.rows.some((r) => r.cells.length > n)) throw new MacroError(`A row has more cells than the ${n} columns.`);
  for (const r of a.highlight ?? []) {
    if (r < 0 || r >= a.rows.length) throw new MacroError(`highlight names row ${r}, but rows count from 0 and there are ${a.rows.length}.`);
  }
  const cellOf = (row: TableArgs["rows"][number], c: number) => {
    const cell = row.cells[c];
    return typeof cell === "object" ? cell : { text: cell ?? "", at: row.at };
  };
  const first = Math.min(...a.rows.flatMap((r) => [r.at, ...r.cells.map((_, c) => cellOf(r, c).at)]));
  const { f, zone, build, top } = start(ctx, first, a.end, a.y);
  const { theme, u } = f;
  const t = theme.type;

  let late = false;
  const columns = a.columns.map((col, c) => {
    const ordered = inOrder(a.rows.map((r) => cellOf(r, c).at));
    late ||= ordered.late;
    return { ...col, texts: a.rows.map((r) => cellOf(r, c).text), times: ordered.times };
  });
  if (late) build.notes.push("A cell was timed before the one above it in its column; it arrives just after that one.");

  const headerText = (h: string) => (t.kickerUppercase ? h.toUpperCase() : h);
  const headerFont = fontOf(theme, "display", theme.weights.kicker, t.kicker, u, t.kickerSpacing);
  const labelled = n > 1;
  const weightOf = (c: number) => (c === 0 && labelled ? 700 : theme.weights.body);
  const widthsAt = (size: number) =>
    columns.map((col, c) =>
      Math.max(col.header ? ctx.measure(headerText(col.header), headerFont) : 0, ...col.texts.map((x) => ctx.measure(x, fontOf(theme, "body", weightOf(c), size, u)))),
    );
  const avail = zone.x1 - zone.x0;
  const minGap = 40 * u;
  let size = a.size ?? t.body;
  let widths = widthsAt(size);
  const needed = () => widths.reduce((sum, w) => sum + w, 0) + minGap * (n - 1);
  for (let tries = 0; tries < 4 && needed() > avail; tries += 1) {
    size = Math.round(size * 0.9);
    widths = widthsAt(size);
  }
  if (needed() > avail) build.notes.push("The table is wider than its space: shorten the cells, or use fewer columns.");
  const natural = widths.reduce((sum, w) => sum + w, 0);
  const gap = n > 1 ? Math.min(120 * u, Math.max(minGap, (avail - natural) / (n - 1))) : 0;
  const tableW = natural + gap * (n - 1);
  const numeric = (x: string) => /^[\s₹$€£¥+\-−~≈]*\d/.test(x);
  const alignOf = (c: number) => columns[c]!.align ?? (c > 0 && columns[c]!.texts.every((x) => !x.trim() || numeric(x)) ? "right" : "left");
  const anchorX = (c: number) => {
    const left = zone.x0 + widths.slice(0, c).reduce((sum, w) => sum + w, 0) + gap * c;
    const align = alignOf(c);
    return align === "left" ? left : align === "right" ? left + widths[c]! : left + widths[c]! / 2;
  };

  const header = columns.some((col) => col.header);
  const headerH = header ? t.kicker * u * 1.3 : 0;
  const ruleY = top + headerH + 14 * u;
  const rowsTop = header ? ruleY + 12 * u : top;
  const rowH = size * u * ROW;
  const middle = zone.x0 + tableW / 2;

  // Behind the text first: the rule, then the cards that highlight rows.
  if (header) build.shape("connector", "line", { cx: middle, cy: ruleY, w: tableW, h: 4 }, first, a.end, "grow");
  for (const r of a.highlight ?? []) {
    build.shape("card-accent", "rectangle", { cx: middle, cy: rowsTop + (r + 0.5) * rowH, w: tableW + 40 * u, h: rowH - 6 * u }, columns[0]!.times[r]!, a.end, "fade");
  }
  columns.forEach((col, c) => {
    if (!col.header) return;
    build.text("kicker", headerText(col.header), { x: anchorX(c), y: top + headerH / 2 }, t.kicker, Math.max(first, col.times[0]! - 0.1), a.end, {
      align: alignOf(c),
      anim: "fade",
      spacing: t.kickerSpacing,
    });
  });
  columns.forEach((col, c) => {
    const begin = col.times[0]!;
    build.text(c === 0 && labelled ? "label" : "body", col.texts.join("\n"), { x: anchorX(c), y: rowsTop + (rowH * col.texts.length) / 2 }, size, begin, a.end, {
      align: alignOf(c),
      anim: "none",
      lineHeight: ROW,
      weight: weightOf(c),
      keyframes: revealKeys(col.times, begin),
    });
  });
  return build.result(rowsTop + rowH * a.rows.length);
}

export interface StackArgs {
  end: number;
  items: { at: number; title: string; value?: string; tone?: "accent" | "neutral" }[];
  connectors?: string[];
  y?: number;
  width?: number;
}

/**
 * Cards stacked down the space, each arriving on its word, a value on the
 * right of each and a label in the gap between two ("↓ ×6"). The titles, the
 * values and the gap labels are one clip each, spaced to sit in their cards:
 * six cards take nine tracks, not twenty-three.
 */
export function addStack(ctx: MacroContext, a: StackArgs): MacroResult {
  const { f, zone, build, top } = start(ctx, Math.min(...a.items.map((i) => i.at)), a.end, a.y);
  const { theme, u } = f;
  const n = a.items.length;
  const ordered = inOrder(a.items.map((i) => i.at));
  if (ordered.late) build.notes.push("A card was timed before the one above it; it arrives just after that one.");
  const cardW = Math.min(zone.x1 - zone.x0, (a.width ?? 760) * u);
  const pad = 32 * u;
  const font = (size: number) => fontOf(theme, "body", 700, size, u);
  const widest = (size: number) => Math.max(...a.items.map((i) => ctx.measure(i.title, font(size)) + (i.value ? ctx.measure(i.value, font(size)) + 32 * u : 0)));
  let size = theme.type.body;
  for (let tries = 0; tries < 4 && widest(size) > cardW - 2 * pad; tries += 1) size = Math.round(size * 0.9);
  if (widest(size) > cardW - 2 * pad) build.notes.push("A card's title and value do not fit on one line: shorten them.");
  const labels = Array.from({ length: Math.max(0, n - 1) }, (_, i) => a.connectors?.[i] ?? "");
  const labelled = labels.some((l) => l.trim());
  const cardH = size * u * 2.3;
  const gap = labelled ? size * u * 1.9 : 18 * u;
  const step = cardH + gap;
  const cx = zone.x0 + cardW / 2;
  // The centre of a block of lines one step apart, whose first line is centred at y0.
  const blockY = (y0: number, lines: number) => y0 + ((lines - 1) * step) / 2;

  a.items.forEach((item, i) => {
    build.shape(item.tone === "accent" ? "card-accent" : "card", "rectangle", { cx, cy: top + cardH / 2 + i * step, w: cardW, h: cardH }, ordered.times[i]!, a.end, "rise");
  });
  const arrive = ordered.times.map((time) => time + 0.1);
  const rows = { anim: "none" as const, lineHeight: step / (size * u), weight: 700 };
  build.text("label", a.items.map((i) => i.title).join("\n"), { x: zone.x0 + pad, y: blockY(top + cardH / 2, n) }, size, arrive[0]!, a.end, { ...rows, keyframes: revealKeys(arrive, arrive[0]!) });
  if (a.items.some((i) => i.value)) {
    build.text("label-accent", a.items.map((i) => i.value ?? "").join("\n"), { x: zone.x0 + cardW - pad, y: blockY(top + cardH / 2, n) }, size, arrive[0]!, a.end, {
      ...rows,
      align: "right",
      keyframes: revealKeys(arrive, arrive[0]!),
    });
  }
  if (labelled) {
    const small = Math.round(size * 0.85);
    const times = ordered.times.slice(1).map((time) => Math.max(ordered.times[0]!, time - 0.15));
    build.text("muted", labels.join("\n"), { x: cx, y: blockY(top + cardH + gap / 2, n - 1) }, small, times[0]!, a.end, {
      align: "center",
      anim: "none",
      lineHeight: step / (small * u),
      keyframes: revealKeys(times, times[0]!),
    });
  }
  return build.result(top + n * step - gap);
}

/** A clip, or a tree's node by the id add_tree was given — within a component, when two trees share ids. */
export type Target = { trackId: string; clipId: string } | { node: string; component?: string };

/** Where a target is drawn at a moment: its centre then, and its size once it has settled. */
function locate(ctx: MacroContext, target: Target, time: number) {
  const project = ctx.project();
  let found: { track: Track; clip: Clip } | undefined;
  if ("node" in target) {
    const name = `node ${target.node}`;
    found = project.tracks
      .flatMap((track) =>
        track.clips
          .filter(
            (c) =>
              c.kind === "shape" &&
              c.name === name &&
              (!target.component || c.component === target.component) &&
              (!ctx.tag?.scene || c.scene === ctx.tag.scene) &&
              c.start <= time + 0.05 &&
              c.start + c.duration > time,
          )
          .map((clip) => ({ track, clip })),
      )
      .sort((p, q) => q.clip.start - p.clip.start)[0];
    if (!found) {
      throw new MacroError(`No tree node "${target.node}" is on screen at ${time.toFixed(2)} s${target.component ? ` in ${target.component}` : ""}. Use an id add_tree was given, at a time after that node arrives.`);
    }
  } else {
    const track = project.tracks.find((t) => t.id === target.trackId);
    const clip = track?.clips.find((c) => c.id === target.clipId);
    if (!track || !clip) throw new MacroError(`There is no clip ${target.clipId} on track ${target.trackId}.`);
    found = { track, clip };
  }
  const { track, clip } = found;
  const asset = project.assets.find((x) => x.id === clip.assetId);
  const source = asset ? { width: asset.width, height: asset.height } : null;
  const boxAt = (t: number) => clipBox(project, clipAt(clip, Math.max(0, Math.min(clip.duration, t - clip.start))), source, false);
  const now = boxAt(time);
  // Sized once an entrance like a pop has finished, so a ring is not drawn around a node still growing.
  const settled = boxAt(Math.max(time, clip.start + 0.6));
  if (!now || !settled) throw new MacroError("That clip has no size on screen to point at.");
  const r = (now.rotation * Math.PI) / 180;
  const lx = now.x + now.w / 2;
  const ly = now.y + now.h / 2;
  return {
    trackIndex: project.tracks.indexOf(track),
    cx: now.cx + lx * Math.cos(r) - ly * Math.sin(r),
    cy: now.cy + lx * Math.sin(r) + ly * Math.cos(r),
    w: settled.w,
    h: settled.h,
    kind: clip.shape?.kind === "ellipse" ? ("ellipse" as const) : ("rectangle" as const),
    radius: clip.shape?.cornerRadius ?? 0,
  };
}

export interface FlashArgs {
  at: number;
  target: Target;
}

/** A ring on something that just arrived or changed: it grows to about 1.9× and fades in 0.7 s. */
export function addFlash(ctx: MacroContext, a: FlashArgs): MacroResult {
  const spot = locate(ctx, a.target, a.at);
  const build = new Build(ctx, frameOf(ctx), spot.trackIndex);
  build.flash(spot, a.at, spot.kind, spot.radius);
  return build.result();
}

export interface CoinArgs {
  stops: { at: number; target: Target }[];
  size?: number;
}

/**
 * A small dot that fades in at the first stop, travels to each next one —
 * arriving on its time, following a node that moves — and fades out at the
 * last: a payment or a referral moving through a tree.
 */
export function addCoin(ctx: MacroContext, a: CoinArgs): MacroResult {
  if (a.stops.length < 2) throw new MacroError("A coin needs at least two stops.");
  const stops = [...a.stops].sort((p, q) => p.at - q.at);
  const spots = stops.map((stop) => locate(ctx, stop.target, stop.at));
  const f = frameOf(ctx);
  const { W, H, u, theme } = f;
  const build = new Build(ctx, f, Math.max(...spots.map((spot) => spot.trackIndex)));
  const d = (a.size ?? 22) * u;
  const begin = Math.max(0, stops[0]!.at - 0.3);
  const landed = stops[stops.length - 1]!.at;
  const clip = shapeClip(begin, landed + 0.4 - begin);
  clip.name = "coin";
  clip.shape = { ...clip.shape!, kind: "ellipse", ...shapeStyleFor("coin", theme) };
  clip.transform = { ...clip.transform, x: spots[0]!.cx / W, y: spots[0]!.cy / H, scale: 1, scaleX: d / (W * 0.3), scaleY: d / (H * 0.3), opacity: 0 };
  const local = (t: number) => t - begin;
  const keys: Keyframe[] = [
    keyframe("transform.opacity", 0, 0, "easeOut"),
    keyframe("transform.opacity", local(stops[0]!.at), 1, "hold"),
    keyframe("transform.opacity", local(landed + 0.05), 1, "easeIn"),
    keyframe("transform.opacity", local(landed + 0.4), 0, "linear"),
  ];
  stops.forEach((stop, i) => {
    const spot = spots[i]!;
    if (i > 0) {
      // It waits at a stop, then leaves in time to arrive at the next on its word.
      const previous = spots[i - 1]!;
      const leaves = stop.at - Math.min(TRAVEL, stop.at - stops[i - 1]!.at);
      keys.push(keyframe("transform.x", local(leaves), previous.cx / W, "ease"), keyframe("transform.y", local(leaves), previous.cy / H, "ease"));
    }
    keys.push(keyframe("transform.x", local(stop.at), spot.cx / W, "linear"), keyframe("transform.y", local(stop.at), spot.cy / H, "linear"));
  });
  clip.keyframes = keys;
  build.add(clip, "coin");
  return build.result();
}
