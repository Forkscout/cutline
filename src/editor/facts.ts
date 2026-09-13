/**
 * Numbers on screen, and whether anyone said them.
 *
 * A figure on a graphic is the easiest thing in an edit to get wrong and the
 * most expensive to ship wrong: TreeFlux's Level 3 price was heard as "7" and
 * said as 60. Every number shown is checked against what was said around it;
 * one nobody said nearby — as digits or as a common number word — goes to the
 * client to confirm, with where it appears and what was heard.
 */

import { settledText } from "./counter";
import { lineArrivesAt } from "./keyframes";
import { wordsOnTimeline, type TimelineWord } from "./transcript";
import type { Fact, Project } from "./types";

export interface OnScreenNumber {
  value: string;
  /** Every clip showing it, earliest first. */
  shown: { trackId: string; clipId: string; start: number; end: number; text: string }[];
  /** Said nearby, as digits or as a number word. */
  heard: boolean;
  /** What was said around its first appearance. */
  excerpt: string;
  /** What the project already records about it. */
  fact: Fact | null;
}

const NUMBER = /(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?%?/gu;

/** Number words a transcript writes out, in English and Hindi. Compound ones are beyond this. */
const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, छह: 6, छे: 6, सात: 7, आठ: 8, नौ: 9, दस: 10,
  बीस: 20, तीस: 30, चालीस: 40, पचास: 50, साठ: 60, सत्तर: 70, अस्सी: 80, नब्बे: 90, सौ: 100, हज़ार: 1000, हजार: 1000, लाख: 100000,
};

/** The digits of a figure, the way it is compared: 1,26,000 and 126000 are one number. */
export const digitsOf = (value: string) => value.replace(/[,%\s]/g, "").replace(/\.0+$/, "");

export function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER)].map((m) => m[0].replace(/[,.]+$/, "")).filter((v) => /\d/.test(v));
}

/** Numbers said in a stretch of transcript, as digit strings. */
function saidNumbers(words: TimelineWord[]): Set<string> {
  const out = new Set<string>();
  words.forEach((w, i) => {
    // Marks stay: Devanagari vowel signs are marks, and तीस without them is तस.
    const bare = w.text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N},.]/gu, "");
    const digits = digitsOf(bare.replace(/^[,.]+|[,.]+$/g, ""));
    if (/^\d+(\.\d+)?$/.test(digits)) out.add(digits);
    // "21 ,600": a number the transcript split at its separator.
    const next = words[i + 1]?.text.trim() ?? "";
    if (/^\d+$/.test(digits) && /^,\d/.test(next)) out.add(digits + digitsOf(next.replace(/[^\d,]/g, "")));
    const word = WORDS[bare.replace(/[,.]/g, "")];
    if (word !== undefined) out.add(String(word));
  });
  return out;
}

/** Every number on screen, with where it is shown and whether it was said nearby. */
export function scanNumbers(project: Project): OnScreenNumber[] {
  const words = wordsOnTimeline(project);
  const byValue = new Map<string, OnScreenNumber>();
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      // A counter is checked for the figure it lands on, not the numbers on the way.
      const content = clip.kind === "text" && clip.text ? settledText(clip.text) : "";
      // A lone digit, or a numbered label like 01, is a step, not a figure.
      if (!content || /^\s*0?\d\s*$/.test(content)) continue;
      // A table column is one clip whose rows arrive at their own times: a figure is on screen from when its line arrives.
      const seen = new Set<string>();
      content.split("\n").forEach((line, index) => {
        for (const value of numbersIn(line)) {
          const arrives = lineArrivesAt(clip, index);
          if (seen.has(value) || !Number.isFinite(arrives)) continue;
          seen.add(value);
          let entry = byValue.get(value);
          if (!entry) {
            entry = { value, shown: [], heard: false, excerpt: "", fact: null };
            byValue.set(value, entry);
          }
          entry.shown.push({ trackId: track.id, clipId: clip.id, start: clip.start + arrives, end: clip.start + clip.duration, text: content });
        }
      });
    }
  }
  for (const entry of byValue.values()) {
    entry.shown.sort((a, b) => a.start - b.start);
    const key = digitsOf(entry.value);
    entry.heard = entry.shown.some((s) => saidNumbers(words.filter((w) => w.start >= s.start - 12 && w.start <= s.end + 4)).has(key));
    const first = entry.shown[0]!;
    entry.excerpt = words
      .filter((w) => w.start >= first.start - 6 && w.start <= first.start + 3)
      .map((w) => w.text)
      .join(" ");
    entry.fact = project.facts.find((f) => f.value === entry.value || digitsOf(f.value) === key) ?? null;
  }
  return [...byValue.values()].sort((a, b) => a.shown[0]!.start - b.shown[0]!.start);
}

/** Needs the client: flagged by an agent and still open, or unheard and not yet settled. */
export const needsConfirming = (n: OnScreenNumber): boolean =>
  n.fact ? n.fact.status === "open" : !n.heard;
