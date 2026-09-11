/**
 * Frames on demand, for an agent to look at.
 *
 * The same `drawFrame` the exporter uses, fed frames decoded at the exact
 * requested times from the originals — not the preview's `<video>` elements,
 * which would mean moving the user's playhead and trusting whatever the
 * element happened to have decoded. What this returns is what the export
 * will contain at that instant.
 */

import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, type VideoSample } from "mediabunny";
import { loadFonts } from "@/lib/fonts";
import { api } from "@/lib/server";
import { assetTimeFor, drawFrame, visibleClips } from "./compositor";
import { assetUrl } from "./media";
import { fontsInUse } from "./themes";
import type { Project } from "./types";

export interface Still {
  data: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked: spreading a megabyte into one fromCharCode call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Frames at each time, drawn at `width` with the project's aspect ratio. */
export async function renderFrames(project: Project, times: number[], width: number): Promise<OffscreenCanvas[]> {
  // What the export will draw: the same web fonts, loaded before the first frame.
  await loadFonts(fontsInUse(project)).catch(() => []);
  const height = Math.max(2, Math.round((width * project.height) / project.width / 2) * 2);
  const scaled: Project = { ...project, width, height };
  const sinks = new Map<string, { input: Input; sink: VideoSampleSink | null }>();
  const stills = new Map<string, ImageBitmap>();
  const out: OffscreenCanvas[] = [];

  try {
    for (const time of times) {
      const frames = new Map<string, CanvasImageSource>();
      const samples: VideoSample[] = [];

      for (const { clip } of visibleClips(scaled, time)) {
        if (clip.kind !== "media" || !clip.assetId) continue;
        const asset = scaled.assets.find((a) => a.id === clip.assetId);
        if (!asset?.hasVideo || asset.offline) continue;

        if (asset.kind === "image") {
          let bitmap = stills.get(asset.id);
          if (!bitmap) {
            const response = await api(assetUrl(asset));
            if (!response.ok) continue;
            bitmap = await createImageBitmap(await response.blob());
            stills.set(asset.id, bitmap);
          }
          frames.set(clip.id, bitmap);
          continue;
        }

        let entry = sinks.get(asset.id);
        if (!entry) {
          const input = new Input({ source: new UrlSource(assetUrl(asset)), formats: ALL_FORMATS });
          const track = await input.getPrimaryVideoTrack();
          entry = { input, sink: track ? new VideoSampleSink(track) : null };
          sinks.set(asset.id, entry);
        }
        const sample = await entry.sink?.getSample(Math.max(0, assetTimeFor(clip, time)));
        if (sample) {
          samples.push(sample);
          frames.set(clip.id, sample.toCanvasImageSource());
        }
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Could not get a 2D context for the frame.");
      drawFrame(
        ctx as unknown as CanvasRenderingContext2D,
        scaled,
        time,
        (clip) => frames.get(clip.id) ?? null,
        { guides: false },
      );
      // Decoded frames live outside the JS heap; leaving them to the garbage
      // collector leaks one per layer per call.
      for (const sample of samples) sample.close();
      out.push(canvas);
    }
  } finally {
    for (const { input } of sinks.values()) input.dispose();
    for (const bitmap of stills.values()) bitmap.close();
  }
  return out;
}

export async function renderStill(
  project: Project,
  time: number,
  width = 960,
  format: "jpeg" | "png" = "jpeg",
): Promise<Still> {
  const [canvas] = await renderFrames(project, [time], width);
  if (!canvas) throw new Error("No frame was drawn.");
  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.85 });
  return { data: await toBase64(blob), mimeType, width: canvas.width, height: canvas.height };
}

const CELL_WIDTH = 320;
const GAP = 4;

/** Frames sampled evenly across a range, in a grid, each labelled with its time. */
export async function contactSheet(
  project: Project,
  start: number,
  end: number,
  count = 9,
): Promise<{ still: Still; times: number[] }> {
  // The last sample sits one frame short of `end`: a clip ends exclusively, so
  // a frame at exactly its end shows whatever comes after it.
  const last = Math.max(start, end - 1 / project.frameRate);
  const times = Array.from({ length: count }, (_, i) =>
    Math.round((start + ((last - start) * i) / Math.max(1, count - 1)) * 1000) / 1000,
  );
  const frames = await renderFrames(project, times, CELL_WIDTH);
  const cellHeight = frames[0]?.height ?? 180;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const sheet = new OffscreenCanvas(cols * CELL_WIDTH + (cols - 1) * GAP, rows * cellHeight + (rows - 1) * GAP);
  const ctx = sheet.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D context for the contact sheet.");
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.textBaseline = "top";

  frames.forEach((frame, i) => {
    const x = (i % cols) * (CELL_WIDTH + GAP);
    const y = Math.floor(i / cols) * (cellHeight + GAP);
    ctx.drawImage(frame, x, y);
    const label = `${times[i]?.toFixed(2)}s`;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x + 4, y + 4, w, 22);
    ctx.fillStyle = "#c3f53c";
    ctx.fillText(label, x + 9, y + 7);
  });

  const blob = await sheet.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return {
    still: { data: await toBase64(blob), mimeType: "image/jpeg", width: sheet.width, height: sheet.height },
    times,
  };
}
