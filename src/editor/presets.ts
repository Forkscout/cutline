/**
 * Frame sizes, delivery presets and background looks.
 *
 * These are the numbers people otherwise have to look up, and getting one wrong
 * costs a re-export — so they live in one place rather than being typed into a
 * dialog each time.
 */

import type { Background } from "./types";

export interface AspectPreset {
  label: string;
  ratio: number;
  hint: string;
}

export const ASPECTS: AspectPreset[] = [
  { label: "16:9", ratio: 16 / 9, hint: "Landscape" },
  { label: "9:16", ratio: 9 / 16, hint: "Vertical" },
  { label: "1:1", ratio: 1, hint: "Square" },
  { label: "4:5", ratio: 4 / 5, hint: "Portrait" },
  { label: "4:3", ratio: 4 / 3, hint: "Classic" },
  { label: "3:4", ratio: 3 / 4, hint: "Tall" },
  { label: "21:9", ratio: 21 / 9, hint: "Cinemascope" },
];

export interface SizePreset {
  group: string;
  label: string;
  width: number;
  height: number;
  frameRate: number;
}

export const SIZE_PRESETS: SizePreset[] = [
  { group: "YouTube", label: "YouTube 1080p", width: 1920, height: 1080, frameRate: 30 },
  { group: "YouTube", label: "YouTube 4K", width: 3840, height: 2160, frameRate: 30 },
  { group: "YouTube", label: "YouTube Shorts", width: 1080, height: 1920, frameRate: 30 },
  { group: "Instagram", label: "Instagram Reels", width: 1080, height: 1920, frameRate: 30 },
  { group: "Instagram", label: "Instagram Feed", width: 1080, height: 1350, frameRate: 30 },
  { group: "Instagram", label: "Instagram Square", width: 1080, height: 1080, frameRate: 30 },
  { group: "Instagram", label: "Instagram Stories", width: 1080, height: 1920, frameRate: 30 },
  { group: "TikTok", label: "TikTok", width: 1080, height: 1920, frameRate: 30 },
  { group: "Meta", label: "Facebook Feed", width: 1280, height: 720, frameRate: 30 },
  { group: "Meta", label: "Facebook Reels", width: 1080, height: 1920, frameRate: 30 },
  { group: "Business", label: "LinkedIn", width: 1920, height: 1080, frameRate: 30 },
  { group: "Business", label: "X / Twitter", width: 1280, height: 720, frameRate: 30 },
  { group: "Generic", label: "720p", width: 1280, height: 720, frameRate: 30 },
  { group: "Generic", label: "1080p", width: 1920, height: 1080, frameRate: 30 },
  { group: "Generic", label: "1440p", width: 2560, height: 1440, frameRate: 30 },
  { group: "Generic", label: "4K", width: 3840, height: 2160, frameRate: 30 },
];

export type Container = "mp4" | "webm";

export interface ExportPreset {
  id: string;
  label: string;
  container: Container;
  height: number;
  frameRate: number;
  /** Megabits per second; null means let the encoder choose by quality. */
  bitrateMbps: number | null;
  quality: "low" | "medium" | "high" | "veryHigh";
  note: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "yt1080", label: "YouTube 1080p", container: "mp4", height: 1080, frameRate: 30, bitrateMbps: 12, quality: "high", note: "H.264, 12 Mbps" },
  { id: "yt4k", label: "YouTube 4K", container: "mp4", height: 2160, frameRate: 30, bitrateMbps: 45, quality: "veryHigh", note: "H.264, 45 Mbps" },
  { id: "shorts", label: "Shorts / Reels / TikTok", container: "mp4", height: 1920, frameRate: 30, bitrateMbps: 10, quality: "high", note: "Vertical, H.264" },
  { id: "web", label: "Web", container: "mp4", height: 720, frameRate: 30, bitrateMbps: 4, quality: "medium", note: "Small and fast" },
  { id: "webm", label: "WebM VP9", container: "webm", height: 1080, frameRate: 30, bitrateMbps: null, quality: "high", note: "Open codec" },
  { id: "master", label: "Master", container: "mp4", height: 2160, frameRate: 60, bitrateMbps: 80, quality: "veryHigh", note: "Archive quality" },
  { id: "small", label: "Small file", container: "mp4", height: 720, frameRate: 24, bitrateMbps: 2, quality: "low", note: "Email and chat" },
];

export interface BackgroundPreset {
  name: string;
  background: Background;
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { name: "Slate", background: { type: "gradient", from: "#1e293b", to: "#0f172a", angle: 135 } },
  { name: "Dusk", background: { type: "gradient", from: "#4c1d95", to: "#1e1b4b", angle: 135 } },
  { name: "Ember", background: { type: "gradient", from: "#7c2d12", to: "#18181b", angle: 135 } },
  { name: "Ocean", background: { type: "gradient", from: "#0e7490", to: "#082f49", angle: 135 } },
  { name: "Moss", background: { type: "gradient", from: "#166534", to: "#052e16", angle: 135 } },
  { name: "Rose", background: { type: "gradient", from: "#9f1239", to: "#3b0764", angle: 135 } },
  { name: "Paper", background: { type: "solid", color: "#e7e5e4" } },
  { name: "White", background: { type: "solid", color: "#ffffff" } },
  { name: "Black", background: { type: "solid", color: "#000000" } },
  { name: "None", background: { type: "transparent" } },
];

/** Nearest standard frame size for a given aspect, keeping the height. */
export function sizeForAspect(height: number, ratio: number): { width: number; height: number } {
  const width = Math.round((height * ratio) / 2) * 2;
  return { width, height: Math.round(height / 2) * 2 };
}
