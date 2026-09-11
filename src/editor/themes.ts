/**
 * Design themes: the look of everything an agent — or a macro — adds.
 *
 * A theme is tokens, not styles: a palette, a display and a body face with a
 * type scale, shape and motion settings, and how the speaker's panel sits in
 * the frame. Macros read the tokens and tag each clip they make with its role
 * (title, chip, card…), which is what lets `setTheme` restyle a finished edit
 * in one step instead of rebuilding it.
 *
 * Sizes are pixels at 1080p, like every other size in the document. Font
 * stacks lead with a web font (loaded for preview and export alike) and fall
 * back to faces a Mac or a PC already has.
 *
 * Pure: no DOM, no "@/" imports. The server lists these too.
 */

import type { Background, CaptionStyle, Clip, ClipRole, ShapeStyle, TextStyle, Theme, ThemePalette } from "./types";

const TYPE: Theme["type"] = {
  kicker: 22,
  title: 58,
  subtitle: 34,
  body: 30,
  small: 24,
  stat: 150,
  kickerSpacing: 5,
  kickerUppercase: true,
  lineHeight: 1.15,
};
const LAYOUT: Theme["layout"] = { margin: 120, panelWidth: 0.25, panelInset: 28, panelRadius: 28 };

const SANS = "Avenir Next, Helvetica Neue, Helvetica, Arial, sans-serif";
const SERIF = "Baskerville, Georgia, Times New Roman, serif";

export const THEMES: Theme[] = [
  {
    id: "studio-dark",
    name: "Studio Dark",
    description: "Charcoal ground, warm amber accent, calm slide-up motion. Sits well beside footage lit by practical lamps; the look of the TreeFlux explainer.",
    palette: {
      background: "#17191e", backgroundTo: "#0b0c0f", surface: "rgba(255,255,255,0.05)", line: "rgba(255,255,255,0.12)",
      text: "#F5F5F4", muted: "#A1A1AA", dim: "#71717A",
      accent: "#FFB547", accentSoft: "rgba(255,181,71,0.14)", accentMuted: "rgba(255,181,71,0.35)",
      positive: "#34D399", positiveSoft: "rgba(52,211,153,0.14)", negative: "#F87171", neutralSoft: "rgba(255,255,255,0.08)",
    },
    fonts: { display: `Plus Jakarta Sans, ${SANS}`, body: `Plus Jakarta Sans, ${SANS}` },
    weights: { display: 700, body: 500, kicker: 700, stat: 800 },
    type: TYPE,
    shape: { radius: 18, stroke: 2 },
    motion: { enter: "slideUp", move: 0.9, stagger: 0.15, exit: 0.35 },
    layout: LAYOUT,
  },
  {
    id: "clean-light",
    name: "Clean Light",
    description: "Near-white ground, ink text, one clear blue. For product walkthroughs, tutorials and anything that should feel like documentation.",
    palette: {
      background: "#F7F7F5", backgroundTo: "#ECECE8", surface: "#FFFFFF", line: "rgba(17,18,20,0.10)",
      text: "#111214", muted: "#5B5F66", dim: "#8A8F98",
      accent: "#2563EB", accentSoft: "rgba(37,99,235,0.10)", accentMuted: "rgba(37,99,235,0.30)",
      positive: "#047857", positiveSoft: "rgba(4,120,87,0.10)", negative: "#DC2626", neutralSoft: "rgba(17,18,20,0.06)",
    },
    fonts: { display: `Inter, ${SANS}`, body: `Inter, ${SANS}` },
    weights: { display: 700, body: 500, kicker: 700, stat: 800 },
    type: TYPE,
    shape: { radius: 14, stroke: 2 },
    motion: { enter: "slideUp", move: 0.8, stagger: 0.12, exit: 0.3 },
    layout: LAYOUT,
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "Paper-white ground, serif headlines, a deep ink-blue accent, slow fades. For essays, interviews and considered long-form.",
    palette: {
      background: "#F4F3EF", backgroundTo: null, surface: "#FFFFFF", line: "rgba(20,20,20,0.14)",
      text: "#141414", muted: "#55524C", dim: "#8B877F",
      accent: "#1F3A93", accentSoft: "rgba(31,58,147,0.10)", accentMuted: "rgba(31,58,147,0.28)",
      positive: "#1E6B45", positiveSoft: "rgba(30,107,69,0.10)", negative: "#B42318", neutralSoft: "rgba(20,20,20,0.06)",
    },
    fonts: { display: `Fraunces, ${SERIF}`, body: `Inter, ${SANS}` },
    weights: { display: 600, body: 500, kicker: 700, stat: 600 },
    type: { ...TYPE, kickerSpacing: 4, title: 62 },
    shape: { radius: 4, stroke: 1.5 },
    motion: { enter: "fade", move: 1.0, stagger: 0.2, exit: 0.45 },
    layout: LAYOUT,
  },
  {
    id: "bold-creator",
    name: "Bold Creator",
    description: "Black ground, heavy type, a loud yellow and quick pop-in motion. For short-form, hooks and high-energy explainers.",
    palette: {
      background: "#0E0E10", backgroundTo: "#050506", surface: "#1B1B1F", line: "rgba(255,255,255,0.14)",
      text: "#FFFFFF", muted: "#B4B4BC", dim: "#77777F",
      accent: "#FFD23F", accentSoft: "rgba(255,210,63,0.16)", accentMuted: "rgba(255,210,63,0.40)",
      positive: "#3DDC97", positiveSoft: "rgba(61,220,151,0.16)", negative: "#FF5D5D", neutralSoft: "rgba(255,255,255,0.10)",
    },
    fonts: { display: `Montserrat, Futura, ${SANS}`, body: `Inter, ${SANS}` },
    weights: { display: 800, body: 600, kicker: 800, stat: 900 },
    type: { ...TYPE, title: 68, subtitle: 38, stat: 170 },
    shape: { radius: 22, stroke: 2 },
    motion: { enter: "pop", move: 0.7, stagger: 0.1, exit: 0.25 },
    layout: LAYOUT,
  },
  {
    id: "corporate",
    name: "Corporate",
    description: "Deep navy ground, clear blue accent, restrained fades. For company updates, investor and B2B explainers.",
    palette: {
      background: "#0B1B33", backgroundTo: "#071225", surface: "rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.14)",
      text: "#F4F7FB", muted: "#9FB0C8", dim: "#6B7C95",
      accent: "#4F9DFF", accentSoft: "rgba(79,157,255,0.14)", accentMuted: "rgba(79,157,255,0.35)",
      positive: "#34C38F", positiveSoft: "rgba(52,195,143,0.14)", negative: "#F46A6A", neutralSoft: "rgba(255,255,255,0.08)",
    },
    fonts: { display: `Manrope, ${SANS}`, body: `Manrope, ${SANS}` },
    weights: { display: 700, body: 500, kicker: 700, stat: 800 },
    type: TYPE,
    shape: { radius: 12, stroke: 2 },
    motion: { enter: "fade", move: 0.9, stagger: 0.15, exit: 0.35 },
    layout: LAYOUT,
  },
  {
    id: "warm-documentary",
    name: "Warm Documentary",
    description: "Dark umber ground, serif display, a soft honey accent and unhurried fades. For stories, founders and anything personal.",
    palette: {
      background: "#1B1613", backgroundTo: "#110D0B", surface: "rgba(255,240,220,0.05)", line: "rgba(255,240,220,0.14)",
      text: "#F2EBE1", muted: "#B9AD9E", dim: "#857A6D",
      accent: "#E3A35B", accentSoft: "rgba(227,163,91,0.14)", accentMuted: "rgba(227,163,91,0.35)",
      positive: "#9CC98A", positiveSoft: "rgba(156,201,138,0.14)", negative: "#E07A6A", neutralSoft: "rgba(255,240,220,0.08)",
    },
    fonts: { display: `DM Serif Display, ${SERIF}`, body: `DM Sans, ${SANS}` },
    weights: { display: 400, body: 500, kicker: 700, stat: 400 },
    type: { ...TYPE, title: 62, stat: 160 },
    shape: { radius: 10, stroke: 1.5 },
    motion: { enter: "fade", move: 1.2, stagger: 0.25, exit: 0.5 },
    layout: LAYOUT,
  },
];

export const THEME_IDS = ["studio-dark", "clean-light", "editorial", "bold-creator", "corporate", "warm-documentary"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME_ID: ThemeId = "studio-dark";

export function themeById(id: string): Theme {
  const theme = THEMES.find((t) => t.id === id);
  if (!theme) throw new Error(`No theme ${id}. Built-in themes: ${THEME_IDS.join(", ")}.`);
  return structuredClone(theme);
}

/** The project's theme, or the default when none has been chosen yet. */
export const themeOf = (project: { theme: Theme | null }): Theme => project.theme ?? themeById(DEFAULT_THEME_ID);

export type ThemePatch = {
  [K in keyof Theme]?: Theme[K] extends object ? Partial<Theme[K]> : Theme[K];
};

/** `base` with `patch` laid over it, one level deep — so a palette patch keeps the other colours. */
export function mergeTheme(base: Theme, patch: ThemePatch): Theme {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object"
        ? { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
  }
  const merged = out as unknown as Theme;
  // A theme someone adjusted is no longer the built-in one of that name.
  if (Object.keys(patch).some((k) => k !== "name") && THEMES.some((t) => t.id === merged.id)) merged.id = `${merged.id}-custom`;
  return merged;
}

/** The first family of a stack: what a font loader fetches. */
export const leadFamily = (stack: string): string => stack.split(",")[0]!.trim().replace(/^["']|["']$/g, "");

/* ------------------------------------------------------------- colour */

/** [r, g, b, a] from #rgb, #rrggbb, #rrggbbaa or rgb()/rgba(). */
export function parseColor(css: string): [number, number, number, number] | null {
  const s = css.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length >= 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s)?.[1];
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((v) => Number.isFinite(v))) return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  return null;
}

export const toHex = ([r, g, b]: readonly number[]): string =>
  `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v ?? 0))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

export function withAlpha(css: string, alpha: number): string {
  const c = parseColor(css);
  return c ? `rgba(${c[0]},${c[1]},${c[2]},${alpha})` : css;
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(css: string): number {
  const c = parseColor(css) ?? [0, 0, 0, 1];
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio, 1–21. Text wants 4.5; large type and graphics 3. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/* -------------------------------------------------------------- roles */

export function textStyleFor(role: ClipRole, theme: Theme): Partial<TextStyle> {
  const p = theme.palette;
  const { display, body } = theme.fonts;
  const w = theme.weights;
  switch (role) {
    case "kicker":
      return { fontFamily: display, fontWeight: w.kicker, color: p.accent, letterSpacing: theme.type.kickerSpacing, background: null };
    case "title":
      return { fontFamily: display, fontWeight: w.display, color: p.text, background: null };
    case "subtitle":
      return { fontFamily: body, fontWeight: Math.min(900, w.body + 100), color: p.text, background: null };
    case "body":
      return { fontFamily: body, fontWeight: w.body, color: p.text, background: null };
    case "muted":
      return { fontFamily: body, fontWeight: w.body, color: p.muted, background: null };
    case "footer":
      return { fontFamily: body, fontWeight: 600, color: p.dim, letterSpacing: 3, background: null };
    case "chip":
      return { fontFamily: body, fontWeight: 600, color: p.accent, background: p.accentSoft };
    case "chip-positive":
      return { fontFamily: body, fontWeight: 600, color: p.positive, background: p.positiveSoft };
    case "chip-neutral":
      return { fontFamily: body, fontWeight: 600, color: p.text, background: p.neutralSoft };
    case "stat":
      return { fontFamily: display, fontWeight: w.stat, color: p.accent, background: null };
    case "label":
      return { fontFamily: body, fontWeight: 700, color: p.text, background: null };
    case "label-accent":
      return { fontFamily: body, fontWeight: 700, color: p.accent, background: null };
    case "number":
      return { fontFamily: body, fontWeight: 800, color: p.accent, background: p.accentSoft };
    case "icon-positive":
      return { color: p.positive, background: null };
    case "icon-negative":
      return { color: p.negative, background: null };
    case "lower-third-name":
      return { fontFamily: display, fontWeight: w.display, color: p.text, background: null };
    case "lower-third-role":
      return { fontFamily: body, fontWeight: w.body, color: p.accent, background: null };
    default:
      return {};
  }
}

export function shapeStyleFor(role: ClipRole, theme: Theme): Partial<ShapeStyle> {
  const p = theme.palette;
  const { radius, stroke } = theme.shape;
  switch (role) {
    case "card":
      return { fill: p.surface, stroke: p.line, strokeWidth: stroke, cornerRadius: radius };
    case "card-accent":
      return { fill: p.surface, stroke: p.accent, strokeWidth: stroke, cornerRadius: radius };
    case "connector":
      return { stroke: p.line, strokeWidth: 3 };
    case "connector-accent":
      return { stroke: p.accent, strokeWidth: 3 };
    case "arrow":
      return { fill: p.accent, strokeWidth: 0 };
    case "node":
      return { fill: p.surface, stroke: p.line, strokeWidth: 3 };
    case "node-accent":
      return { fill: p.accentSoft, stroke: p.accent, strokeWidth: 3 };
    case "node-positive":
      return { fill: p.positiveSoft, stroke: p.positive, strokeWidth: 3 };
    case "bar":
      return { fill: p.accentMuted, strokeWidth: 0, cornerRadius: Math.min(8, radius) };
    case "bar-accent":
      return { fill: p.accent, strokeWidth: 0, cornerRadius: Math.min(8, radius) };
    case "scrim":
      return { fill: withAlpha(p.background, 0.78), strokeWidth: 0, cornerRadius: radius };
    case "lower-third-plate":
      return { fill: withAlpha(p.background, 0.86), stroke: p.line, strokeWidth: 1, cornerRadius: radius };
    default:
      return {};
  }
}

/** A clip made from tokens, in `theme`'s colours and faces. Sizes and positions are left alone. */
export function restyleClip(clip: Clip, theme: Theme): Clip {
  if (!clip.role) return clip;
  if (clip.kind === "text" && clip.text) return { ...clip, text: { ...clip.text, ...textStyleFor(clip.role, theme) } };
  if (clip.kind === "shape" && clip.shape) return { ...clip, shape: { ...clip.shape, ...shapeStyleFor(clip.role, theme) } };
  if (clip.kind === "media" && clip.role === "speaker") return clip;
  return clip;
}

export function themeBackground(theme: Theme): Background {
  const p: ThemePalette = theme.palette;
  return p.backgroundTo
    ? { type: "gradient", from: p.background, to: p.backgroundTo, angle: 135 }
    : { type: "solid", color: p.background };
}

export function themeCaptionStyle(theme: Theme): Partial<CaptionStyle> {
  return {
    fontFamily: theme.fonts.body,
    color: luminance(theme.palette.background) > 0.5 ? theme.palette.text : "#ffffff",
    background: withAlpha(theme.palette.background, 0.72),
  };
}

/** Every web font a project's text asks for: lead families of each stack in use. */
export function fontsInUse(project: { tracks: { clips: Clip[] }[]; theme: Theme | null; captionStyle: CaptionStyle }): string[] {
  const stacks = new Set<string>([project.captionStyle.fontFamily]);
  if (project.theme) {
    stacks.add(project.theme.fonts.display);
    stacks.add(project.theme.fonts.body);
  }
  for (const track of project.tracks) for (const clip of track.clips) if (clip.text) stacks.add(clip.text.fontFamily);
  return [...new Set([...stacks].map(leadFamily))];
}
