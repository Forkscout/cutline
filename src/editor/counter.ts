/**
 * Numbers that count up.
 *
 * A text clip with a `counter` shows `from` + (`to` − `from`) × `counterValue`,
 * formatted as the figure was written — Indian grouping for 1,26,000, a prefix
 * like ₹, a suffix like " seats" — and `text.counterValue` is keyframed from 0
 * to 1. Content is a string and cannot be animated; a number can.
 *
 * No DOM: the compositor formats in the export worker too.
 */

import type { TextCounter, TextStyle } from "./types";

const formats = new Map<string, Intl.NumberFormat>();

function formatter(c: TextCounter): Intl.NumberFormat {
  const key = `${c.locale}|${c.decimals}|${c.grouping}`;
  let format = formats.get(key);
  if (!format) {
    const options = { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals, useGrouping: c.grouping };
    try {
      format = new Intl.NumberFormat(c.locale, options);
    } catch {
      format = new Intl.NumberFormat("en-US", options);
    }
    formats.set(key, format);
  }
  return format;
}

/** A value as the counter writes it. */
export function formatCount(c: TextCounter, value: number): string {
  return `${c.prefix}${formatter(c).format(value)}${c.suffix}`;
}

/** What a counting clip shows `progress` of the way, 0..1 — by default where its counterValue is now. */
export function counterText(style: TextStyle, progress = style.counterValue ?? 1): string {
  const c = style.counter;
  if (!c) return style.content;
  const p = Math.max(0, Math.min(1, progress));
  return formatCount(c, c.from + (c.to - c.from) * p);
}

/** What a text clip says once it has settled: a counter's final figure, or its content. */
export function settledText(style: TextStyle): string {
  return style.counter ? counterText(style, 1) : style.content;
}

const FIGURE = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(\D*)$/;

/**
 * A counter for text that is one plain figure — "₹1,26,000", "46,656 seats",
 * "12.5%" — counting from 0, or null when the text is anything else or would
 * not be written back exactly as it is.
 */
export function parseFigure(text: string): TextCounter | null {
  const match = FIGURE.exec(text.trim());
  if (!match) return null;
  const [, prefix = "", written = "", suffix = ""] = match;
  const [whole = "", fraction = ""] = written.split(".");
  const to = Number(written.replace(/,/g, ""));
  if (!Number.isFinite(to)) return null;
  const groups = whole.replace("-", "").split(",");
  // 1,26,000: pairs between the first group and the last three digits.
  const indian = groups.length > 2 && groups.slice(1, -1).every((g) => g.length === 2) && groups[groups.length - 1]!.length === 3;
  const counter: TextCounter = { from: 0, to, decimals: fraction.length, locale: indian ? "en-IN" : "en-US", grouping: groups.length > 1, prefix, suffix };
  return formatCount(counter, to) === text.trim() ? counter : null;
}
