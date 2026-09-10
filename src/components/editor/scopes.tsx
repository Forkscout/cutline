import { useEffect, useRef } from "react";

export type ScopeKind = "histogram" | "waveform" | "parade" | "vectorscope";

/**
 * Video scopes, computed from the program canvas.
 *
 * Sampled on a stride rather than every pixel: a 1080p frame is two million
 * samples, and reading every one of them per repaint would cost more than the
 * compositing that produced it. Every fourth pixel is statistically identical
 * for a scope's purpose and roughly sixteen times cheaper.
 */
const STRIDE = 4;

export function Scope({
  source,
  kind,
  version,
}: {
  source: HTMLCanvasElement | null;
  kind: ScopeKind;
  /** Bump to force a recompute — scopes cannot observe canvas writes. */
  version: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const target = ref.current;
    if (!target || !source || source.width === 0) return;
    const ctx = target.getContext("2d");
    if (!ctx) return;

    // Downscale first: reading ImageData straight off a 4K program canvas is
    // the slow part, not the arithmetic that follows.
    const sampleW = Math.min(320, source.width);
    const sampleH = Math.max(1, Math.round((source.height / source.width) * sampleW));
    const scratch = document.createElement("canvas");
    scratch.width = sampleW;
    scratch.height = sampleH;
    const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
    if (!scratchCtx) return;
    scratchCtx.drawImage(source, 0, 0, sampleW, sampleH);

    let pixels: Uint8ClampedArray;
    try {
      pixels = scratchCtx.getImageData(0, 0, sampleW, sampleH).data;
    } catch {
      return;
    }

    const w = target.width;
    const h = target.height;
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, w, h);

    if (kind === "histogram") {
      const bins = { r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) };
      for (let i = 0; i < pixels.length; i += 4 * STRIDE) {
        bins.r[pixels[i] ?? 0] += 1;
        bins.g[pixels[i + 1] ?? 0] += 1;
        bins.b[pixels[i + 2] ?? 0] += 1;
      }
      const peak = Math.max(...bins.r, ...bins.g, ...bins.b, 1);
      const channels: [number[], string][] = [
        [bins.r, "rgba(255,80,80,0.75)"],
        [bins.g, "rgba(80,255,120,0.75)"],
        [bins.b, "rgba(90,140,255,0.75)"],
      ];
      ctx.globalCompositeOperation = "screen";
      for (const [bin, color] of channels) {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < 256; i += 1) {
          ctx.lineTo((i / 255) * w, h - ((bin[i] ?? 0) / peak) * h);
        }
        ctx.lineTo(w, h);
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      return;
    }

    if (kind === "waveform" || kind === "parade") {
      const parade = kind === "parade";
      const lanes = parade ? 3 : 1;
      const laneW = w / lanes;
      ctx.globalCompositeOperation = "screen";

      for (let y = 0; y < sampleH; y += STRIDE) {
        for (let x = 0; x < sampleW; x += STRIDE) {
          const i = (y * sampleW + x) * 4;
          const r = pixels[i] ?? 0;
          const g = pixels[i + 1] ?? 0;
          const b = pixels[i + 2] ?? 0;
          const px = (x / sampleW) * laneW;

          if (parade) {
            ctx.fillStyle = "rgba(255,60,60,0.30)";
            ctx.fillRect(px, h - (r / 255) * h, 1, 1);
            ctx.fillStyle = "rgba(60,255,110,0.30)";
            ctx.fillRect(laneW + px, h - (g / 255) * h, 1, 1);
            ctx.fillStyle = "rgba(80,130,255,0.30)";
            ctx.fillRect(laneW * 2 + px, h - (b / 255) * h, 1, 1);
          } else {
            // Rec.709 luma — the weighting a broadcast waveform monitor uses.
            const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            ctx.fillStyle = "rgba(120,255,170,0.28)";
            ctx.fillRect(px, h - (luma / 255) * h, 1, 1);
          }
        }
      }
      ctx.globalCompositeOperation = "source-over";

      // IRE graticule at 0, 50 and 100.
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      for (const level of [0, 0.5, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, h - level * h);
        ctx.lineTo(w, h - level * h);
        ctx.stroke();
      }
      return;
    }

    // Vectorscope: chroma plotted on the U/V plane, so hue is angle and
    // saturation is distance from the centre.
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 4;
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.75, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = "rgba(140,255,190,0.35)";
    for (let i = 0; i < pixels.length; i += 4 * STRIDE) {
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      const u = -0.169 * r - 0.331 * g + 0.5 * b;
      const v = 0.5 * r - 0.419 * g - 0.081 * b;
      ctx.fillRect(cx + (u / 128) * radius, cy - (v / 128) * radius, 1, 1);
    }
    ctx.globalCompositeOperation = "source-over";
  }, [source, kind, version]);

  return <canvas ref={ref} width={260} height={150} className="w-full rounded border bg-black" />;
}
