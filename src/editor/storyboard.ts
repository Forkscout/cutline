/**
 * The storyboard: what the video shows, scene by scene, written by the agent
 * as data — each scene's layout and components, and the words they land on —
 * and turned into clips by Cutline. The agent decides what; the compiler
 * decides how, through the macros and the theme, the same way every time.
 *
 * It is the difference between ~1300 hand-placed calls for the TreeFlux edit
 * and one JSON: consistent, cheap to change (edit a scene, compile again), and
 * still ordinary clips the user can touch. Every clip carries its scene and
 * component, so a compile replaces only what compiles made: locked scenes and
 * clips the user edited by hand are left where they are.
 */

import * as macros from "./agent-macros";
import { wordsOnTimeline, type TimelineWord } from "./transcript";
import type { Anchor, Project, StoryComponent, StoryScene } from "./types";

export class AnchorError extends Error {}

/** Lower case, no punctuation, no nukta: the form words are compared in. */
export const normalizeWord = (s: string): string =>
  s.normalize("NFKC").toLowerCase().replace(/़/g, "").replace(/[^\p{L}\p{N}\p{M}\s]/gu, "").trim();

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = current;
    }
  }
  return row[b.length]!;
}

/** Transcripts misspell: one letter off, or one word the start of the other, still matches. */
const close = (a: string, b: string) =>
  a === b ||
  (Math.min(a.length, b.length) >= 4 && levenshtein(a, b) <= 1) ||
  (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** The first time `phrase` is said at or after `after`. */
export function findPhrase(words: TimelineWord[], phrase: string, after: number): TimelineWord | null {
  const tokens = normalizeWord(phrase).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const norm = words.map((w) => normalizeWord(w.text));
  for (let i = 0; i < words.length; i += 1) {
    if (words[i]!.start < after - 0.05) continue;
    let k = 0;
    while (k < tokens.length && norm[i + k] !== undefined && close(norm[i + k]!, tokens[k]!)) k += 1;
    if (k === tokens.length) return words[i]!;
  }
  return null;
}

function nearest(words: TimelineWord[], phrase: string, after: number): string {
  const token = normalizeWord(phrase).split(/\s+/)[0] ?? "";
  const scored = words
    .filter((w) => w.start >= after - 0.05)
    .map((w) => ({ w, d: levenshtein(normalizeWord(w.text), token) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  return scored.length ? ` Closest: ${scored.map(({ w }) => `"${w.text}" at ${w.start.toFixed(1)} s`).join(", ")}.` : "";
}

/** A time from an anchor, looking for words only at or after `after`. */
export function resolveAnchor(anchor: Anchor, words: TimelineWord[], after: number): number {
  if ("time" in anchor) return Math.max(0, anchor.time + (anchor.offset ?? 0));
  if (words.length === 0) throw new AnchorError(`"${anchor.word}" needs a transcript: transcribe the speaker's clip first, or anchor on a time.`);
  const hit = findPhrase(words, anchor.word, after);
  if (!hit) throw new AnchorError(`"${anchor.word}" is not said after ${after.toFixed(1)} s.${nearest(words, anchor.word, after)}`);
  return Math.max(0, hit.start + (anchor.offset ?? 0));
}

/** Each scene's times as a compile would find them, or why its anchors do not resolve. */
export function sceneTimes(project: Project): Map<string, { from: number; to: number } | { error: string }> {
  const out = new Map<string, { from: number; to: number } | { error: string }>();
  const words = wordsOnTimeline(project);
  let cursor = 0;
  for (const scene of project.storyboard?.scenes ?? []) {
    try {
      const from = resolveAnchor(scene.from, words, cursor);
      const to = resolveAnchor(scene.to, words, from + 0.01);
      out.set(scene.id, { from, to });
      cursor = from;
    } catch (err) {
      out.set(scene.id, { error: message(err) });
    }
  }
  return out;
}

export interface CompiledScene {
  id: string;
  from: number;
  to: number;
  layout: string;
  clips: number;
  skipped?: "locked" | "not asked";
  notes: string[];
}

export interface CompileReport {
  scenes: CompiledScene[];
  errors: string[];
  removed: number;
  /** Clips from earlier compiles the user edited by hand, left alone. */
  kept: number;
}

const round = (n: number) => Math.round(n * 100) / 100;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function compileComponent(ctx: macros.MacroContext, c: StoryComponent, words: TimelineWord[], from: number, end: number): macros.MacroResult {
  let after = from;
  const at = (a: Anchor) => {
    const t = resolveAnchor(a, words, after);
    after = t;
    return t;
  };
  const until = c.until ? Math.min(end, resolveAnchor(c.until, words, from)) : end;
  const y = c.y !== undefined ? { y: c.y } : {};
  switch (c.type) {
    case "title":
      return macros.addTitle(ctx, { start: at(c.at), end: until, title: c.title, ...(c.kicker ? { kicker: c.kicker } : {}), ...(c.subtitle ? { subtitle: c.subtitle } : {}), ...y });
    case "points":
      return macros.addPoints(ctx, { end: until, items: c.items.map((i) => ({ ...i, at: at(i.at) })), ...y });
    case "chips":
      return macros.addChips(ctx, { end: until, items: c.items.map((i) => ({ ...i, at: at(i.at) })), ...y });
    case "stat":
      return macros.addStat(ctx, { start: at(c.at), end: until, value: c.value, ...(c.label ? { label: c.label } : {}), ...(c.count ? { count: true } : {}), ...y });
    case "statement":
      return macros.addStatement(ctx, { end: until, lines: c.lines.map((l) => ({ ...l, at: at(l.at) })), ...(c.size ? { size: c.size } : {}), ...y });
    case "flow":
      return macros.addFlow(ctx, { end: until, steps: c.steps.map((s) => ({ ...s, at: at(s.at) })), ...(c.highlight ? { highlight: c.highlight } : {}), ...y });
    case "cards":
      return macros.addCards(ctx, { end: until, cards: c.cards.map((k) => ({ ...k, at: at(k.at) })), ...(c.highlight ? { highlight: c.highlight } : {}), ...y });
    case "split":
      return macros.addSplit(ctx, { end: until, source: { ...c.source, at: at(c.source.at) }, branches: c.branches.map((b) => ({ ...b, at: at(b.at) })), ...y });
    case "bars":
      return macros.addBars(ctx, {
        end: until,
        items: c.items.map((i) => ({ ...i, at: at(i.at) })),
        ...(c.orientation ? { orientation: c.orientation } : {}),
        ...(c.scale ? { scale: c.scale } : {}),
        ...(c.highlight ? { highlight: c.highlight } : {}),
        ...(c.height ? { height: c.height } : {}),
        ...y,
      });
    case "tally":
      return macros.addTally(ctx, { end: until, items: c.items.map((i) => ({ ...i, at: at(i.at) })), ...y });
    case "tree": {
      const nodes = c.nodes.map((n) => ({ ...n, at: at(n.at) }));
      const moves = (c.moves ?? []).map((m) => ({ ...m, at: resolveAnchor(m.at, words, nodes.find((n) => n.id === m.node)?.at ?? from) }));
      return macros.addTree(ctx, { end: until, nodes, moves, ...(c.ghost ? { ghost: c.ghost } : {}), ...y });
    }
    case "lower_third":
      return macros.addLowerThird(ctx, { start: at(c.at), end: until, name: c.name, ...(c.role ? { role: c.role } : {}) });
    case "table": {
      const rows = c.rows.map((r) => ({ ...r, at: at(r.at) }));
      // A cell with its own word is looked for after its row, and after the cell above it.
      const after = c.columns.map(() => from);
      return macros.addTable(ctx, {
        end: until,
        columns: c.columns,
        rows: rows.map((r) => ({
          at: r.at,
          cells: r.cells.map((cell, i) => {
            if (typeof cell === "string") return cell;
            const t = resolveAnchor(cell.at, words, Math.max(r.at, after[i] ?? from));
            after[i] = t;
            return { text: cell.text, at: t };
          }),
        })),
        ...(c.highlight ? { highlight: c.highlight } : {}),
        ...y,
      });
    }
    case "stack":
      return macros.addStack(ctx, { end: until, items: c.items.map((i) => ({ ...i, at: at(i.at) })), ...(c.connectors ? { connectors: c.connectors } : {}), ...y });
    case "flash":
      return macros.addFlash(ctx, { at: at(c.at), target: { node: c.node, ...(c.tree ? { component: c.tree } : {}) } });
    case "coin":
      return macros.addCoin(ctx, { stops: c.stops.map((s) => ({ at: at(s.at), target: { node: s.node, ...(c.tree ? { component: c.tree } : {}) } })) });
  }
}

/**
 * Compiles the storyboard into clips. `only` compiles just those scenes (the
 * layout is always rebuilt from the whole storyboard, so it stays consistent).
 * Nothing is changed when a scene's times cannot be resolved.
 */
export function compileStoryboard(ctx: macros.MacroContext, options: { only?: string[] } = {}): CompileReport {
  const project = ctx.project();
  const storyboard = project.storyboard;
  if (!storyboard?.scenes.length) throw new macros.MacroError("There is no storyboard to compile. set_storyboard first.");
  const words = wordsOnTimeline(project);
  const report: CompileReport = { scenes: [], errors: [], removed: 0, kept: 0 };

  // 1. When each scene happens. Each looks for its words after the one before.
  const timed: { scene: StoryScene; from: number; to: number }[] = [];
  let cursor = 0;
  for (const scene of storyboard.scenes) {
    try {
      const from = resolveAnchor(scene.from, words, cursor);
      const to = resolveAnchor(scene.to, words, from + 0.01);
      if (to <= from) throw new AnchorError("it ends before it starts");
      timed.push({ scene, from, to });
      cursor = from;
    } catch (err) {
      report.errors.push(`Scene ${scene.id}: ${message(err)}`);
    }
  }
  if (report.errors.length) return report;
  const notesFor = new Map<string, string[]>();
  for (let i = 0; i + 1 < timed.length; i += 1) {
    if (timed[i + 1]!.from < timed[i]!.to) {
      timed[i]!.to = timed[i + 1]!.from - 0.15;
      notesFor.set(timed[i]!.scene.id, [`Ends at ${round(timed[i]!.to)} s, where ${timed[i + 1]!.scene.id} begins.`]);
    }
  }

  const compiling = new Set(timed.filter((t) => !t.scene.locked && (!options.only || options.only.includes(t.scene.id))).map((t) => t.scene.id));
  const known = new Set(storyboard.scenes.map((s) => s.id));

  // 2. Take away what earlier compiles made for these scenes, and for scenes no
  //    longer in the storyboard — never a clip the user edited by hand.
  const stale: { trackId: string; clipId: string }[] = [];
  for (const track of ctx.project().tracks) {
    for (const clip of track.clips) {
      if (!clip.scene || !(compiling.has(clip.scene) || (!options.only && !known.has(clip.scene)))) continue;
      if (clip.userEdited || track.locked) report.kept += 1;
      else stale.push({ trackId: track.id, clipId: clip.id });
    }
  }
  for (const ref of stale) ctx.commit({ type: "deleteClip", ref });
  report.removed = stale.length;

  // 3. The speaker's layout, from the whole storyboard: into each scene's
  //    layout just before it starts, back to full frame across gaps of 3 s or more.
  const first = timed[0]!;
  const speaker = macros.findSpeaker(ctx.project(), first.from + 0.5);
  if (speaker && !speaker.clip.userEdited && !speaker.track.locked) {
    ctx.commit({
      type: "patchClip",
      ref: { trackId: speaker.track.id, clipId: speaker.clip.id },
      patch: { keyframes: speaker.clip.keyframes.filter((k) => !(macros.MOVED as readonly string[]).includes(k.property)) },
    });
    const ref = { trackId: speaker.track.id, clipId: speaker.clip.id };
    let current: "panel" | "full" | "pip" = "full";
    timed.forEach((t, i) => {
      const want = t.scene.layout === "backdrop" ? "full" : t.scene.layout;
      const previousEnd = i > 0 ? timed[i - 1]!.to : 0;
      if (i > 0 && current !== "full" && t.from - previousEnd >= 3) {
        macros.layoutMove(ctx, { at: previousEnd + 0.05, to: "full", ...ref });
        current = "full";
      }
      if (want !== current) {
        const subjectX = t.scene.subjectX ?? storyboard.subjectX;
        macros.layoutMove(ctx, {
          at: Math.max(0, t.from - 0.3),
          to: want,
          ...ref,
          ...(t.scene.side ? { side: t.scene.side } : {}),
          ...(subjectX !== undefined ? { subjectX } : {}),
        });
        current = want;
      }
    });
    const last = timed[timed.length - 1]!;
    const clipEnd = speaker.clip.start + speaker.clip.duration;
    if (current !== "full" && clipEnd - last.to >= 3) macros.layoutMove(ctx, { at: last.to + 0.05, to: "full", ...ref });
  } else if (speaker) {
    report.errors.push(
      speaker.track.locked
        ? "The speaker's track is locked, so its layout moves were left as they are."
        : "The speaker's clip was edited by hand, so its layout moves were left as they are.",
    );
  }

  // 4. The scenes' components, through the macros, each clip tagged with its scene and component.
  for (const t of timed) {
    const base: CompiledScene = { id: t.scene.id, from: round(t.from), to: round(t.to), layout: t.scene.layout, clips: 0, notes: notesFor.get(t.scene.id) ?? [] };
    if (!compiling.has(t.scene.id)) {
      report.scenes.push({ ...base, skipped: t.scene.locked ? "locked" : "not asked" });
      continue;
    }
    const end = t.to - 0.05;
    const tagged = (component: string): macros.MacroContext => ({ ...ctx, tag: { scene: t.scene.id, component } });
    const run = (component: string, make: (c: macros.MacroContext) => macros.MacroResult) => {
      try {
        const result = make(tagged(component));
        base.clips += result.clips.length;
        base.notes.push(...result.notes);
      } catch (err) {
        report.errors.push(`Scene ${t.scene.id}, ${component}: ${message(err)}`);
      }
    };
    if (t.scene.layout === "backdrop") run("backdrop", (c) => macros.addBackdrop(c, { start: t.from, end }));
    if (storyboard.footer && t.scene.layout !== "full") run("footer", (c) => macros.addFooter(c, { start: t.from + 0.2, end, text: storyboard.footer! }));
    for (const component of t.scene.components) run(component.id, (c) => compileComponent(c, component, words, t.from, end));
    report.scenes.push(base);
  }
  ctx.commit({ type: "setStoryboard", storyboard: { ...storyboard, compiledAt: Date.now() } });
  return report;
}
