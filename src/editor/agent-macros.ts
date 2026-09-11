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
import { readProperty, valueAt } from "./keyframes";
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
  /** Stamped on every clip made, when a storyboard compile is making them. */
  tag?: { scene: string; component: string };
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
      clip.scene = this.ctx.tag.scene;
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
    o: { align?: "left" | "center" | "right"; anim?: TextAnimation; lineHeight?: number; pad?: number; weight?: number; spacing?: number } = {},
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
    return this.add(clip, role);
  }

  /** A shape centred at (cx, cy), w by h project pixels. "grow" draws it from its start along its direction. */
  shape(
    role: ClipRole,
    kind: ShapeKind,
    box: { cx: number; cy: number; w: number; h: number; rotation?: number },
    start: number,
    end: number,
    enter: "rise" | "grow" | "pop" | "fade" = "rise",
  ): Placed {
    const { theme, W, H, u } = this.f;
    const clip = shapeClip(start, Math.max(0.1, end - start));
    clip.name = role;
    clip.shape = { ...clip.shape!, kind, fill: "rgba(0,0,0,0)", stroke: "rgba(0,0,0,0)", strokeWidth: 0, cornerRadius: 0, ...shapeStyleFor(role, theme) };
    const scaleX = box.w / (W * 0.3);
    const scaleY = box.h / (H * 0.3);
    const rotation = box.rotation ?? 0;
    clip.transform = { ...clip.transform, x: box.cx / W, y: box.cy / H, scale: 1, scaleX, scaleY, rotation };
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
      } else if (enter === "pop") {
        clip.keyframes.push(keyframe("transform.scale", 0, 0.6, "easeOut"), keyframe("transform.scale", 0.45, 1, "linear"));
      }
    }
    return this.add(clip, role);
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

/** A line from one point to another, as a shape box. */
function lineBox(x1: number, y1: number, x2: number, y2: number, r1 = 0, r2 = 0) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ax = x1 + ux * r1;
  const ay = y1 + uy * r1;
  const bx = x2 - ux * r2;
  const by = y2 - uy * r2;
  return { cx: (ax + bx) / 2, cy: (ay + by) / 2, w: Math.max(1, Math.hypot(bx - ax, by - ay)), h: 4, rotation: (Math.atan2(dy, dx) * 180) / Math.PI };
}

export interface TreeArgs {
  end: number;
  nodes: { id: string; label: string; parent?: string | null; at: number; tone?: "accent" | "positive" | "neutral"; note?: string }[];
  moves?: { node: string; parent: string; at: number }[];
  y?: number;
  size?: number;
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

  const d = (a.size ?? 96) * u;
  const gapY = 190 * u;
  const layout = (parents: Map<string, string | null>) => {
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

  const initialParents = new Map(a.nodes.map((n) => [n.id, n.parent ?? null] as const));
  const finalParents = new Map(initialParents);
  for (const m of a.moves ?? []) finalParents.set(m.node, m.parent);
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
      build.shape(nodeRole, "ellipse", { cx: from.x, cy: from.y, w: size, h: size }, n.at, a.end, "pop"),
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
    }
  }
  const depth = Math.max(...[...settled.values()].map((p) => p.depth));
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
