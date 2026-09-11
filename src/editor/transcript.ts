/**
 * Transcripts: words with times, and what the editor makes of them.
 *
 * The server produces them — it holds the API key and talks to whichever
 * OpenAI-compatible transcription service the user connected — and the editor
 * turns them into captions and, later, into cuts. Types and pure functions
 * only: the server imports this file too.
 *
 * Times in a transcript are in the audio file's own time. Mapping them onto
 * the timeline goes through the clips that use that file, so trimming or
 * moving a clip never invalidates its transcript.
 */

import type { CaptionCue, Clip, Project } from "./types";

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  version: 1;
  /** The connected service's name, as the user gave it. */
  provider: string;
  model: string;
  language: string | null;
  durationSec: number;
  /**
   * "word" when the service gave a time for every word. "segment" when it only
   * timed sentences and the words were spread across each by length — good
   * enough for captions, not for cutting on a word.
   */
  timing: "word" | "segment";
  words: TranscriptWord[];
  createdAt: number;
}

interface Piece {
  word?: string;
  text?: string;
  start: number;
  end: number;
}

/** The parts of an OpenAI-style `verbose_json` response this reads. */
export interface VerboseJson {
  text?: string;
  language?: string;
  duration?: number;
  words?: Piece[];
  segments?: { start: number; end: number; text: string; words?: Piece[] }[];
}

/** Special tokens some servers leave in: [_BEG_], [BLANK_AUDIO], (music). */
const NOT_SPEECH = /^\s*[[(].*[\])]\s*$/;

/**
 * Words from a `verbose_json` response, shifted by `offset` seconds.
 *
 * Handles the shapes seen in practice. OpenAI puts whole words in a top-level
 * `words` array. whisper.cpp's server puts them under each segment as tokens —
 * " Cut", then "line" — where a piece without leading space continues the word
 * before it. Services that give no word times at all get their segments
 * spread across their words by length.
 */
export function wordsFromVerboseJson(json: VerboseJson, offset = 0): { words: TranscriptWord[]; timing: Transcript["timing"] } {
  const out: TranscriptWord[] = [];
  const push = (text: string, start: number, end: number) => {
    const clean = text.trim();
    if (!clean || NOT_SPEECH.test(clean)) return;
    out.push({ start: start + offset, end: Math.max(start, end) + offset, text: clean });
  };

  if (json.words?.length) {
    for (const w of json.words) push(w.word ?? w.text ?? "", w.start, w.end);
    return { words: out, timing: "word" };
  }

  const tokens = json.segments?.flatMap((s) => s.words ?? []) ?? [];
  if (tokens.length > 0) {
    let current: TranscriptWord | null = null;
    for (const token of tokens) {
      const raw = token.word ?? token.text ?? "";
      if (!raw || NOT_SPEECH.test(raw)) continue;
      if (current && !/^\s/.test(raw)) {
        current.text += raw;
        current.end = Math.max(current.end, token.end);
        continue;
      }
      if (current) push(current.text, current.start, current.end);
      current = { start: token.start, end: token.end, text: raw };
    }
    if (current) push(current.text, current.start, current.end);
    return { words: out, timing: "word" };
  }

  for (const segment of json.segments ?? []) {
    const parts = segment.text.trim().split(/\s+/).filter(Boolean);
    const letters = parts.reduce((n, p) => n + p.length, 0) || 1;
    let at = segment.start;
    for (const part of parts) {
      const length = ((segment.end - segment.start) * part.length) / letters;
      push(part, at, at + length);
      at += length;
    }
  }
  return { words: out, timing: "segment" };
}

/* ---------------------------------------------------------- on the timeline */

export interface TimelineWord extends TranscriptWord {
  clipId: string;
  trackId: string;
}

/** Where a moment of the source lands on the timeline through `clip`, if it does. */
function toTimeline(clip: Clip, sourceTime: number): number | null {
  if (clip.reversed || clip.freeze) return null;
  const t = clip.start + (sourceTime - clip.inPoint) / clip.speed;
  return t >= clip.start - 0.001 && t <= clip.start + clip.duration + 0.001 ? t : null;
}

/** Every transcribed word heard on the timeline, in order. */
export function wordsOnTimeline(project: Project): TimelineWord[] {
  const out: TimelineWord[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.enabled || clip.kind !== "media") continue;
      const transcript = project.assets.find((a) => a.id === clip.assetId)?.transcript;
      if (!transcript) continue;
      for (const word of transcript.words) {
        // A word counts where its middle lands inside the clip: a trim through
        // a word keeps it if most of it is still heard.
        const middle = toTimeline(clip, (word.start + word.end) / 2);
        if (middle === null) continue;
        const start = toTimeline(clip, word.start) ?? clip.start;
        const end = toTimeline(clip, word.end) ?? clip.start + clip.duration;
        out.push({ start, end, text: word.text, clipId: clip.id, trackId: track.id });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface CaptionRules {
  /** One line of a caption; two lines is too much to read at a glance. */
  maxChars: number;
  maxSeconds: number;
  /** A pause this long ends a caption. */
  gapSeconds: number;
}

export const DEFAULT_CAPTION_RULES: CaptionRules = { maxChars: 42, maxSeconds: 5, gapSeconds: 0.6 };

const ENDS_SENTENCE = /[.!?।]$/;
const ENDS_CLAUSE = /[.!?।,;:]$/;
/** How far a line may run past the limit to finish its sentence instead of orphaning the last word. */
const FINISH_ALLOWANCE = 10;

/**
 * Groups the words heard on the timeline into caption cues: a new cue at a
 * pause, at the end of a sentence, or when the line would run too long to
 * read. Cues have no ids; the caller gives them some.
 *
 * Two rules keep the lines readable. A line may run a few characters long to
 * take the word that ends its sentence, rather than open the next caption with
 * "captions." alone. And a line that must break breaks after its last comma or
 * full stop when it has one, not mid-clause.
 */
export function captionsFromWords(words: TranscriptWord[], rules = DEFAULT_CAPTION_RULES): Omit<CaptionCue, "id">[] {
  const cues: Omit<CaptionCue, "id">[] = [];
  let current: TranscriptWord[] = [];

  const emit = (group: TranscriptWord[]) => {
    if (group.length === 0) return;
    const text = group.map((w) => w.text).join(" ").replace(/\s+([,.!?;:।])/g, "$1");
    cues.push({ start: group[0]!.start, end: group[group.length - 1]!.end, text });
  };
  const lengthOf = (group: TranscriptWord[]) => group.reduce((n, w) => n + w.text.length + 1, 0) - 1;

  for (const word of words) {
    const last = current[current.length - 1];
    if (last) {
      const length = lengthOf(current) + 1 + word.text.length;
      const pause = word.start - last.end > rules.gapSeconds;
      const sentenceEnded = ENDS_SENTENCE.test(last.text) && current.length >= 3;
      const finishes = ENDS_SENTENCE.test(word.text) && length <= rules.maxChars + FINISH_ALLOWANCE;
      const tooLong =
        (length > rules.maxChars && !finishes) || word.end - current[0]!.start > rules.maxSeconds;

      if (pause || sentenceEnded) {
        emit(current);
        current = [];
      } else if (tooLong) {
        // Break after the last clause inside the line, if there is one with
        // at least two words on each side of it.
        let at = -1;
        for (let i = current.length - 2; i >= 1; i -= 1) {
          if (ENDS_CLAUSE.test(current[i]!.text)) {
            at = i;
            break;
          }
        }
        if (at >= 1 && current.length - (at + 1) >= 1) {
          emit(current.slice(0, at + 1));
          current = current.slice(at + 1);
        } else {
          emit(current);
          current = [];
        }
      }
    }
    current.push(word);
  }
  emit(current);
  return cues;
}
