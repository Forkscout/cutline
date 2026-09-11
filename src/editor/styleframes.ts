/**
 * The same frame of the edit in several themes, side by side — so the client
 * chooses a look from a picture instead of from adjectives.
 *
 * Each cell is the project restyled with `setTheme`, exactly as choosing that
 * theme would leave it, then drawn by `renderFrames` — the export's drawing,
 * fonts included. Only clips the macros made (the ones with a role) change,
 * so build one scene with them first and preview on a frame of it.
 */

import { reduce } from "./project";
import { renderFrames } from "./snapshot";
import type { Project, Theme } from "./types";

export interface ThemeSheet {
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  /** Left to right, top to bottom. */
  themes: { id: string; name: string }[];
}

const LABEL_H = 34;
const GAP = 6;

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function themeSheet(project: Project, time: number, themes: Theme[], cellWidth = 480): Promise<ThemeSheet> {
  const frames: OffscreenCanvas[] = [];
  for (const theme of themes) {
    const styled = reduce(project, { type: "setTheme", theme, restyle: true });
    const [frame] = await renderFrames(styled, [time], cellWidth);
    if (!frame) throw new Error("No frame was drawn.");
    frames.push(frame);
  }
  const cellH = frames[0]!.height;
  const cols = themes.length <= 3 ? themes.length : Math.ceil(themes.length / 2);
  const rows = Math.ceil(themes.length / cols);
  const sheet = new OffscreenCanvas(cols * cellWidth + (cols - 1) * GAP, rows * (cellH + LABEL_H) + (rows - 1) * GAP);
  const ctx = sheet.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D context for the sheet.");
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.textBaseline = "middle";
  frames.forEach((frame, i) => {
    const theme = themes[i]!;
    const x = (i % cols) * (cellWidth + GAP);
    const y = Math.floor(i / cols) * (cellH + LABEL_H + GAP);
    ctx.drawImage(frame, x, y + LABEL_H);
    ctx.fillStyle = theme.palette.accent;
    ctx.fillRect(x + 8, y + 11, 12, 12);
    ctx.fillStyle = "#f5f5f4";
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.fillText(`${i + 1}. ${theme.name}`, x + 28, y + LABEL_H / 2);
  });
  const blob = await sheet.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  return { data: await toBase64(blob), mimeType: "image/jpeg", width: sheet.width, height: sheet.height, themes: themes.map((t) => ({ id: t.id, name: t.name })) };
}
