/**
 * Checks graphics the way the export will draw them, so an agent — or the
 * user — finds a broken scene before a viewer does.
 *
 * Geometry comes from `clipBox`, the function the renderer and the on-canvas
 * handles use, at moments when entrances have settled. Contrast is measured on
 * frames `drawFrame` renders from the originals: the text's colour against what
 * is really behind it, not against the colour the theme meant to be there.
 */

import { findSpeaker } from "./agent-macros";
import { clipBox, textLineBoxes, visibleClips, type ClipBox } from "./compositor";
import { clipAt, lineArrivesAt } from "./keyframes";
import { renderFrames } from "./snapshot";
import { sceneTimes } from "./storyboard";
import { contrast, parseColor, toHex } from "./themes";
import type { Clip, Project, Track } from "./types";

export type LintKind = "overlap" | "off-frame" | "contrast" | "over-speaker" | "too-brief";

export interface LintClip {
  trackId: string;
  clipId: string;
  text?: string;
  scene?: string;
  component?: string;
}

export interface LintIssue {
  kind: LintKind;
  severity: "error" | "warning";
  /** A moment the problem shows, for render_frame or the playhead. */
  time: number;
  clips: LintClip[];
  detail: string;
  fix: string;
}

export interface LintReport {
  from: number;
  to: number;
  /** Graphics clips in the range. */
  checked: number;
  /** Moments looked at. */
  samples: number;
  /** Text clips whose contrast was measured on a rendered frame. */
  contrastMeasured: number;
  notes: string[];
  issues: LintIssue[];
}

export class LintError extends Error {}

/** Which problem an issue is, across versions of a project: its kind and the clips it names. */
export const issueKey = (issue: LintIssue): string => `${issue.kind}:${issue.clips.map((c) => c.clipId).sort().join("+")}`;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Placed {
  track: Track;
  clip: Clip;
  rect: Rect;
  text: string;
  /** Which line of a text clip, since lines are checked one by one. */
  line?: number;
}

/** Marks that pass over other things on purpose: a coin travelling, a ring flashing. */
const MOTION = new Set<string>(["coin", "flash"]);

/** Frames rendered for contrast, at most: a long timeline is sampled, not rendered whole. */
const MAX_FRAMES = 80;
/** Title-safe, as a fraction of the frame from each edge. */
const SAFE = 0.03;

const round = (n: number) => Math.round(n * 100) / 100;
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const intersect = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const contains = (outer: Rect, inner: Rect, slack = 2) =>
  inner.x0 >= outer.x0 - slack && inner.y0 >= outer.y0 - slack && inner.x1 <= outer.x1 + slack && inner.y1 <= outer.y1 + slack;
const quote = (text: string) => `“${text.length > 32 ? `${text.slice(0, 30)}…` : text}”`;

/** The upright box around a possibly rotated one. */
function bounds(b: ClipBox): Rect {
  const r = (b.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]] as const) {
    xs.push(b.cx + x * cos - y * sin);
    ys.push(b.cy + x * sin + y * cos);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const describe = ({ track, clip, text }: { track: Track; clip: Clip; text: string }): LintClip => ({
  trackId: track.id,
  clipId: clip.id,
  ...(text ? { text: text.slice(0, 60) } : {}),
  ...(clip.scene ? { scene: clip.scene } : {}),
  ...(clip.component ? { component: clip.component } : {}),
});

/** Text and shapes on screen at a moment, where they are drawn. */
function placed(project: Project, time: number): Placed[] {
  const out: Placed[] = [];
  for (const { track, clip } of visibleClips(project, time)) {
    if (clip.kind !== "text" && clip.kind !== "shape") continue;
    const now = clipAt(clip, time - clip.start);
    if (now.transform.opacity < 0.05) continue;
    if (clip.kind === "text") {
      // Line by line: a table column is one clip, its rows in different cards and some not arrived yet.
      for (const line of textLineBoxes(project, now)) {
        if (now.text?.reveal !== undefined && now.text.reveal - line.index < 0.5) continue;
        if (line.box.w > 0) out.push({ track, clip, rect: bounds(line.box), text: line.text, line: line.index });
      }
      continue;
    }
    const box = clipBox(project, now, null, false);
    if (!box || box.w <= 0 || box.h <= 0) continue;
    out.push({ track, clip, rect: bounds(box), text: "" });
  }
  return out;
}

/**
 * Where the speaker's face is, near enough: a fifth of the source's width
 * around subjectX, in the upper half of the speaker's picture as placed.
 */
function faceAt(project: Project, time: number, subjectX: number): Rect | null {
  const speaker = findSpeaker(project, time);
  if (!speaker) return null;
  const asset = project.assets.find((a) => a.id === speaker.clip.assetId);
  if (!asset?.width || !asset.height) return null;
  const now = clipAt(speaker.clip, time - speaker.clip.start);
  const firstVideo = project.tracks.findIndex((t) => t.kind === "video");
  const box = clipBox(project, now, { width: asset.width, height: asset.height }, speaker.trackIndex === firstVideo);
  if (!box) return null;
  const { left, right } = now.transform.crop;
  const visible = 1 - left - right;
  if (visible <= 0 || subjectX < left || subjectX > 1 - right) return null;
  const x0 = box.cx + box.x;
  const y0 = box.cy + box.y;
  const faceX = x0 + ((subjectX - left) / visible) * box.w;
  const half = ((box.w / visible) * 0.2) / 2;
  return { x0: Math.max(x0, faceX - half), x1: Math.min(x0 + box.w, faceX + half), y0: y0 + box.h * 0.08, y1: y0 + box.h * 0.55 };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * The text's contrast against what is behind it on a rendered frame. The
 * background is the median of the box's pixels that are not the text's own
 * colour; the text's opacity is mixed in, and a stroke of 2 px or more counts.
 */
function measure(ctx: OffscreenCanvasRenderingContext2D, p: Placed, scale: number, time: number): { value: number; behind: string } | null {
  const style = p.clip.text;
  const fg = style ? parseColor(style.color) : null;
  if (!style || !fg) return null;
  const x = Math.max(0, Math.floor(p.rect.x0 * scale));
  const y = Math.max(0, Math.floor(p.rect.y0 * scale));
  const w = Math.min(ctx.canvas.width, Math.ceil(p.rect.x1 * scale)) - x;
  const h = Math.min(ctx.canvas.height, Math.ceil(p.rect.y1 * scale)) - y;
  if (w < 2 || h < 2) return null;
  const data = ctx.getImageData(x, y, w, h).data;
  const far: [number[], number[], number[]] = [[], [], []];
  const all: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    all[0].push(r);
    all[1].push(g);
    all[2].push(b);
    if (Math.hypot(r - fg[0], g - fg[1], b - fg[2]) > 80) {
      far[0].push(r);
      far[1].push(g);
      far[2].push(b);
    }
  }
  // Text the same colour as its ground leaves nothing "far": then the box is all ground.
  const ground = far[0].length >= 0.15 * all[0].length ? far : all;
  const bg = ground.map(median);
  const alpha = Math.max(0, Math.min(1, clipAt(p.clip, time - p.clip.start).transform.opacity * fg[3]));
  const shown = [0, 1, 2].map((c) => fg[c]! * alpha + bg[c]! * (1 - alpha));
  let value = contrast(toHex(shown), toHex(bg));
  const stroke = style.strokeWidth >= 2 ? parseColor(style.strokeColor) : null;
  if (stroke) value = Math.max(value, contrast(toHex(stroke), toHex(bg)));
  return { value, behind: toHex(bg) };
}

/** Lints a storyboard scene, a range, or the whole timeline. */
export async function lintScene(
  project: Project,
  options: { scene?: string; from?: number; to?: number; contrast?: boolean } = {},
): Promise<LintReport> {
  const end = Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  let from = options.from ?? 0;
  let to = options.to ?? end;
  if (options.scene) {
    const times = sceneTimes(project).get(options.scene);
    if (!times) throw new LintError(`There is no scene ${options.scene} in the storyboard.`);
    if ("error" in times) throw new LintError(`Scene ${options.scene} does not resolve: ${times.error}`);
    ({ from, to } = times);
  }
  if (to <= from) throw new LintError("The range is empty.");

  const W = project.width;
  const H = project.height;
  const graphics = project.tracks.flatMap((track) =>
    track.hidden ? [] : track.clips.filter((c) => (c.kind === "text" || c.kind === "shape") && c.start < to && c.start + c.duration > from).map((clip) => ({ track, clip })),
  );
  // Each graphic once it has settled — entrances take up to 0.6 s — and just before it goes.
  const moments: number[] = [];
  for (const { clip } of graphics) {
    for (const t of [clip.start + Math.min(0.65, clip.duration / 2), clip.start + clip.duration - 0.15]) {
      if (t >= from && t <= to && t >= clip.start && t < clip.start + clip.duration) moments.push(round(t));
    }
  }
  const samples = [...new Set(moments)].sort((a, b) => a - b);

  const issues = new Map<string, LintIssue>();
  const add = (issue: LintIssue) => {
    const key = issueKey(issue);
    if (!issues.has(key)) issues.set(key, issue);
  };
  const notes: string[] = [];
  const subjectX = project.storyboard?.subjectX;
  if (subjectX === undefined) {
    notes.push("The speaker's face was taken to be at the centre of their picture; set the storyboard's subjectX (analyze_media finds it) for a better guess.");
  }
  const firstSeen = new Map<string, { time: number; p: Placed }>();

  for (const time of samples) {
    const here = placed(project, time);
    for (const p of here) if (p.text && !firstSeen.has(`${p.clip.id}:${p.line ?? 0}`)) firstSeen.set(`${p.clip.id}:${p.line ?? 0}`, { time, p });

    // Text on text; text running over the edge of a shape it is not inside.
    for (let i = 0; i < here.length; i += 1) {
      for (let j = i + 1; j < here.length; j += 1) {
        const a = here[i]!;
        const b = here[j]!;
        if (a.clip === b.clip || MOTION.has(a.clip.role ?? "") || MOTION.has(b.clip.role ?? "")) continue;
        const texts = [a, b].filter((p) => p.text);
        if (texts.length === 0) continue;
        const overlap = area(intersect(a.rect, b.rect));
        if (overlap <= 0) continue;
        if (texts.length === 2) {
          if (overlap > 0.04 * Math.min(area(a.rect), area(b.rect))) {
            add({ kind: "overlap", severity: "error", time, clips: [describe(a), describe(b)], detail: `${quote(a.text)} and ${quote(b.text)} overlap.`, fix: "Move one, shorten one, or let the first leave before the second arrives." });
          }
        } else {
          const t = texts[0]!;
          const shape = t === a ? b : a;
          if (!contains(shape.rect, t.rect) && overlap > 0.12 * area(t.rect)) {
            add({ kind: "overlap", severity: "warning", time, clips: [describe(t), describe(shape)], detail: `${quote(t.text)} runs over the edge of a shape it is not inside.`, fix: "Keep text inside its card, and clear of lines and other shapes." });
          }
        }
      }
    }

    for (const p of here) {
      const r = p.rect;
      if (p.clip.kind === "shape" && area(r) >= 0.9 * W * H) continue; // a backdrop
      if (r.x0 < -2 || r.y0 < -2 || r.x1 > W + 2 || r.y1 > H + 2) {
        add({ kind: "off-frame", severity: "error", time, clips: [describe(p)], detail: `${p.text ? quote(p.text) : "A shape"} runs off the frame (${Math.round(r.x0)}–${Math.round(r.x1)} × ${Math.round(r.y0)}–${Math.round(r.y1)} in ${W}×${H}).`, fix: "Move it in, make it smaller, or wrap the text." });
      } else if (p.text && (r.x0 < W * SAFE || r.y0 < H * SAFE || r.x1 > W * (1 - SAFE) || r.y1 > H * (1 - SAFE))) {
        add({ kind: "off-frame", severity: "warning", time, clips: [describe(p)], detail: `${quote(p.text)} sits within 3% of the edge, outside title-safe.`, fix: "Bring it in: platforms crop the edges and lay their own controls over them." });
      }
    }

    const face = faceAt(project, time, subjectX ?? 0.5);
    if (face && area(face) > 0) {
      for (const p of here) {
        if (!p.text) continue;
        const covered = area(intersect(p.rect, face));
        if (covered > 0.1 * area(face) || covered > 0.25 * area(p.rect)) {
          add({ kind: "over-speaker", severity: "warning", time, clips: [describe(p)], detail: `${quote(p.text)} covers the speaker's face.`, fix: "Move it beside the speaker, or change the layout for this stretch." });
        }
      }
    }
  }

  for (const { track, clip } of graphics) {
    const text = clip.kind === "text" ? (clip.text?.content ?? "").trim() : "";
    // A table's column is read a row at a time, each row from when it arrives.
    const pieces = clip.keyframes.some((k) => k.property === "text.reveal")
      ? (clip.text?.content ?? "").split("\n").map((line, i) => ({ words: line.split(/\s+/).filter(Boolean).length, shown: clip.duration - lineArrivesAt(clip, i) }))
      : [{ words: text.split(/\s+/).filter(Boolean).length, shown: clip.duration }];
    const brief = pieces.find((piece) => piece.words >= 3 && Number.isFinite(piece.shown) && piece.shown < 0.6 + piece.words / 3.2);
    if (brief) {
      const { words, shown } = brief;
      const needed = 0.6 + words / 3.2;
      add({ kind: "too-brief", severity: "warning", time: round(clip.start + Math.min(0.65, clip.duration / 2)), clips: [describe({ track, clip, text })], detail: `${words} words on screen for ${shown.toFixed(1)} s; reading them takes about ${needed.toFixed(1)} s.`, fix: "Keep it up longer, or say it in fewer words." });
    }
  }

  let contrastMeasured = 0;
  if (options.contrast !== false && firstSeen.size > 0) {
    const wanted = [...firstSeen.values()];
    const allTimes = [...new Set(wanted.map((w) => w.time))];
    const frameTimes = allTimes.slice(0, MAX_FRAMES);
    if (frameTimes.length < allTimes.length) notes.push(`Contrast was measured at the first ${MAX_FRAMES} moments only; lint a scene or a range for the rest.`);
    const width = Math.min(960, W);
    const scale = width / W;
    const frames = await renderFrames(project, frameTimes, width);
    frames.forEach((canvas, i) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      for (const { time, p } of wanted) {
        if (time !== frameTimes[i]) continue;
        const ratio = measure(ctx, p, scale, time);
        if (!ratio) continue;
        contrastMeasured += 1;
        const style = p.clip.text!;
        const px = style.fontSize * (1080 / H);
        const large = px >= 40 || (style.fontWeight >= 700 && px >= 30);
        const need = large ? 3 : 4.5;
        if (ratio.value < need) {
          add({ kind: "contrast", severity: ratio.value < (large ? 2 : 3) ? "error" : "warning", time, clips: [describe(p)], detail: `${quote(p.text)} is ${ratio.value.toFixed(1)}:1 against ${ratio.behind} behind it; ${large ? "large" : "body"} text needs ${need}:1.`, fix: "Change the text colour, or put a card or a shadow behind it." });
        }
      }
    });
  }

  const list = [...issues.values()].sort((a, b) => (a.severity === b.severity ? a.time - b.time : a.severity === "error" ? -1 : 1));
  return { from: round(from), to: round(to), checked: graphics.length, samples: samples.length, contrastMeasured, notes, issues: list };
}
