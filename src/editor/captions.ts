/**
 * Subtitle import and export.
 *
 * SRT and WebVTT differ in almost nothing that matters — a header, and a comma
 * versus a full stop in the timestamps — so one parser handles both and the
 * writer takes a flag.
 */

import type { CaptionCue } from "./types";

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function parseTime(text: string): number | null {
  const match = TIME.exec(text);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number((ms ?? "0").padEnd(3, "0")) / 1000
  );
}

function formatTime(seconds: number, comma: boolean): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? "," : "."}${pad(ms, 3)}`;
}

/** Parses SRT or WebVTT. Cue numbers, WEBVTT headers and NOTEs are ignored. */
export function parseSubtitles(text: string): CaptionCue[] {
  const normalised = text.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const blocks = normalised.split(/\n{2,}/);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0]!) || /^NOTE\b/i.test(lines[0]!)) continue;

    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;

    const [rawStart, rawEnd] = lines[timingIndex]!.split("-->");
    const start = parseTime(rawStart ?? "");
    const end = parseTime(rawEnd ?? "");
    if (start === null || end === null) continue;

    const content = lines
      .slice(timingIndex + 1)
      // Strip the inline tags WebVTT allows; the renderer draws plain text.
      .map((l) => l.replace(/<[^>]+>/g, ""))
      .join("\n")
      .trim();
    if (content === "") continue;

    cues.push({ id: crypto.randomUUID(), start, end: Math.max(end, start + 0.1), text: content });
  }

  return cues.sort((a, b) => a.start - b.start);
}

export function toSrt(cues: CaptionCue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${formatTime(cue.start, true)} --> ${formatTime(cue.end, true)}\n${cue.text}\n`,
    )
    .join("\n");
}

export function toVtt(cues: CaptionCue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${formatTime(cue.start, false)} --> ${formatTime(cue.end, false)}\n${cue.text}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
