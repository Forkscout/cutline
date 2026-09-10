/**
 * Draws the sequence at one instant onto a 2D context.
 *
 * This function is the contract between the preview and the export. The preview
 * hands it frames out of `<video>` elements, the exporter hands it frames
 * decoded by mediabunny, and neither knows the difference — which is the only
 * way to be sure that what the user approved is what the file contains. Any
 * effect added here must be added here *only*; adding one to the preview alone
 * is precisely the bug this design exists to prevent.
 */

import { clipAt } from "./keyframes";
import { effectsToFilter, gradeToFilter, isNeutralGrade, overlayEffects } from "./effects";
import type {
  Clip,
  ColorGrade,
  EffectInstance,
  MediaAsset,
  Project,
  ShapeStyle,
  TextStyle,
  Transform,
  Transition,
  Track,
} from "./types";

/** Supplies the current picture for a clip, or null if it is not ready yet. */
export type FrameResolver = (clip: Clip, asset: MediaAsset) => CanvasImageSource | null;

export interface DrawOptions {
  /** Preview only — guides must never reach an exported file. */
  guides?: boolean;
}

/** Radius, shadow and font sizes are authored against a 1080-tall frame. */
const REFERENCE_HEIGHT = 1080;

/* ------------------------------------------------------------- scratch pool */

/**
 * Scratch canvases, reused across frames and keyed by purpose.
 *
 * Allocating a 1080p canvas costs a few megabytes and a GPU surface; doing it
 * per layer per frame is the difference between a preview that plays and one
 * that stutters every time the garbage collector catches up.
 */
const scratch = new Map<string, HTMLCanvasElement>();

function getScratch(key: string, width: number, height: number): HTMLCanvasElement {
  let canvas = scratch.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    scratch.set(key, canvas);
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}

/* ------------------------------------------------------------------ sizing */

/**
 * Every CanvasImageSource spells its dimensions differently, and a VideoFrame —
 * which is what the exporter feeds in — has no `width`/`height` at all, only
 * `displayWidth`/`displayHeight`. Reading the wrong pair yields `undefined`,
 * which propagates through the layout maths as NaN and makes `drawImage` a
 * silent no-op: an export of exactly the right length, codec and resolution,
 * showing nothing but the background.
 */
function sourceSize(image: CanvasImageSource): { w: number; h: number } {
  if (image instanceof HTMLVideoElement) return { w: image.videoWidth, h: image.videoHeight };
  if (image instanceof HTMLImageElement) return { w: image.naturalWidth, h: image.naturalHeight };
  if (typeof VideoFrame !== "undefined" && image instanceof VideoFrame) {
    return { w: image.displayWidth, h: image.displayHeight };
  }
  const sized = image as { width: number; height: number };
  return { w: sized.width, h: sized.height };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* -------------------------------------------------------------- background */

function paintBackground(ctx: CanvasRenderingContext2D, project: Project) {
  const { width: w, height: h, background } = project;
  ctx.clearRect(0, 0, w, h);
  if (background.type === "transparent") return;

  if (background.type === "solid") {
    ctx.fillStyle = background.color;
  } else {
    const radians = (background.angle * Math.PI) / 180;
    // Project the gradient line onto the frame so the stops always land on
    // opposite corners, whatever the angle.
    const length = Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians));
    const dx = (Math.cos(radians) * length) / 2;
    const dy = (Math.sin(radians) * length) / 2;
    const gradient = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
    gradient.addColorStop(0, background.from);
    gradient.addColorStop(1, background.to);
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, w, h);
}

/* ------------------------------------------------------------- chroma key */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

/**
 * Keys out a colour, returning a canvas with transparency where it matched.
 *
 * This is the one place a per-pixel pass is unavoidable — no CSS filter can
 * express "make this hue transparent" — so it only runs when the user has
 * actually switched chroma keying on.
 */
function applyChromaKey(
  image: CanvasImageSource,
  chroma: { color: string; similarity: number; smoothness: number; spill: number },
): HTMLCanvasElement | null {
  const { w, h } = sourceSize(image);
  if (!(w > 0) || !(h > 0)) return null;

  const canvas = getScratch("chroma", Math.round(w), Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const key = hexToRgb(chroma.color);
  // Distances are compared in a 0..1 space so the sliders behave the same
  // whatever key colour is chosen.
  const near = chroma.similarity * 441.67;
  const far = near + Math.max(1, chroma.smoothness * 441.67);

  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] ?? 0;
    const g = px[i + 1] ?? 0;
    const b = px[i + 2] ?? 0;
    const distance = Math.sqrt((r - key.r) ** 2 + (g - key.g) ** 2 + (b - key.b) ** 2);

    if (distance < near) {
      px[i + 3] = 0;
    } else if (distance < far) {
      px[i + 3] = Math.round(((distance - near) / (far - near)) * (px[i + 3] ?? 255));
    }

    // Spill suppression: pull the key channel down toward the other two so
    // green fringing around hair and shoulders stops glowing.
    if (chroma.spill > 0 && px[i + 3] !== 0) {
      const avg = (r + b) / 2;
      if (key.g > key.r && key.g > key.b && g > avg) {
        px[i + 1] = Math.round(g - (g - avg) * chroma.spill);
      } else if (key.b > key.r && key.b > key.g && b > (r + g) / 2) {
        px[i + 2] = Math.round(b - (b - (r + g) / 2) * chroma.spill);
      }
    }
  }

  ctx.putImageData(data, 0, 0);
  return canvas;
}

/* ---------------------------------------------------------- overlay effects */

let noiseTile: HTMLCanvasElement | null = null;

/** One noise tile, generated once and reused — regenerating per frame is the
 *  single most expensive thing a grain effect can do. */
function getNoiseTile(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(size, size);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = Math.round(Math.random() * 255);
    data.data[i] = v;
    data.data[i + 1] = v;
    data.data[i + 2] = v;
    data.data[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  noiseTile = canvas;
  return canvas;
}

function drawOverlayEffects(
  ctx: CanvasRenderingContext2D,
  effects: EffectInstance[],
  box: Box,
  unit: number,
) {
  for (const effect of effects) {
    const p = effect.params;
    ctx.save();
    switch (effect.type) {
      case "vignette": {
        const amount = (p.amount ?? 0) / 100;
        const softness = (p.softness ?? 50) / 100;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const outer = Math.max(box.w, box.h) * 0.75;
        const gradient = ctx.createRadialGradient(cx, cy, outer * (1 - softness), cx, cy, outer);
        gradient.addColorStop(0, "rgba(0,0,0,0)");
        gradient.addColorStop(1, `rgba(0,0,0,${amount.toFixed(3)})`);
        ctx.fillStyle = gradient;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        break;
      }
      case "grain": {
        ctx.globalAlpha = (p.amount ?? 0) / 100 / 3;
        ctx.globalCompositeOperation = "overlay";
        const tile = getNoiseTile();
        const pattern = ctx.createPattern(tile, "repeat");
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(box.x, box.y, box.w, box.h);
        }
        break;
      }
      case "scanlines": {
        const spacing = Math.max(2, Math.round((p.spacing ?? 4) * unit));
        ctx.globalAlpha = (p.amount ?? 0) / 100;
        ctx.fillStyle = "#000";
        for (let y = box.y; y < box.y + box.h; y += spacing) {
          ctx.fillRect(box.x, y, box.w, Math.max(1, spacing / 3));
        }
        break;
      }
      case "tint": {
        ctx.globalAlpha = (p.amount ?? 0) / 100;
        ctx.globalCompositeOperation = "color";
        ctx.fillStyle = `hsl(${p.hue ?? 210} 80% 50%)`;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }
}

/**
 * Effects that have to change the picture itself rather than paint over it, so
 * they run on the layer's own canvas before it is composited.
 */
function applyPixelEffects(
  source: CanvasImageSource,
  effects: EffectInstance[],
): CanvasImageSource {
  const pixelate = effects.find((e) => e.type === "pixelate");
  const posterize = effects.find((e) => e.type === "posterize");
  const aberration = effects.find((e) => e.type === "chromaticAberration");
  const glow = effects.find((e) => e.type === "glow");
  if (!pixelate && !posterize && !aberration && !glow) return source;

  const { w, h } = sourceSize(source);
  if (!(w > 0) || !(h > 0)) return source;
  const canvas = getScratch("pixel", Math.round(w), Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: Boolean(posterize) });
  if (!ctx) return source;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (pixelate) {
    const size = Math.max(2, pixelate.params.size ?? 12);
    const smallW = Math.max(1, Math.round(canvas.width / size));
    const smallH = Math.max(1, Math.round(canvas.height / size));
    const small = getScratch("pixel-small", smallW, smallH);
    const smallCtx = small.getContext("2d");
    if (smallCtx) {
      smallCtx.clearRect(0, 0, smallW, smallH);
      smallCtx.drawImage(source, 0, 0, smallW, smallH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
    }
  } else {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }

  if (aberration) {
    // Offsetting the red and blue channels apart is what a cheap lens does;
    // 'screen' recombines them without darkening the result.
    const shift = ((aberration.params.amount ?? 20) / 100) * (canvas.width * 0.01);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.filter = "url(#none)";
    ctx.globalAlpha = 0.5;
    ctx.drawImage(canvas, -shift, 0);
    ctx.drawImage(canvas, shift, 0);
    ctx.restore();
  }

  if (glow) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = (glow.params.amount ?? 50) / 200;
    ctx.filter = `blur(${glow.params.radius ?? 24}px)`;
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
  }

  if (posterize) {
    const levels = Math.max(2, Math.round(posterize.params.levels ?? 6));
    const step = 255 / (levels - 1);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = Math.round(Math.round((px[i] ?? 0) / step) * step);
      px[i + 1] = Math.round(Math.round((px[i + 1] ?? 0) / step) * step);
      px[i + 2] = Math.round(Math.round((px[i + 2] ?? 0) / step) * step);
    }
    ctx.putImageData(data, 0, 0);
  }

  return canvas;
}

/* -------------------------------------------------------------- transitions */

const EASE = (t: number) => t * t * (3 - 2 * t);

export interface TransitionState {
  /** 0..1, where 1 is fully present. */
  progress: number;
  transition: Transition;
  /** True while entering, false while leaving. */
  entering: boolean;
}

/** Which transition, if any, is running on this clip at this instant. */
export function transitionAt(clip: Clip, localTime: number): TransitionState | null {
  const inT = clip.transitionIn;
  if (inT.type !== "none" && inT.duration > 0 && localTime < inT.duration) {
    return { progress: EASE(localTime / inT.duration), transition: inT, entering: true };
  }
  const outT = clip.transitionOut;
  const fromEnd = clip.duration - localTime;
  if (outT.type !== "none" && outT.duration > 0 && fromEnd < outT.duration) {
    return { progress: EASE(fromEnd / outT.duration), transition: outT, entering: false };
  }
  return null;
}

/** Applies the geometric part of a transition; returns the alpha to draw at. */
function applyTransition(
  ctx: CanvasRenderingContext2D,
  state: TransitionState,
  project: Project,
): number {
  const { progress, transition } = state;
  const w = project.width;
  const h = project.height;
  const away = 1 - progress;

  switch (transition.type) {
    case "dissolve":
      return progress;
    case "fadeToBlack":
    case "fadeToWhite":
      // The flood colour is painted after the layer, in drawFrame.
      return progress;
    case "wipeLeft":
      ctx.beginPath();
      ctx.rect(0, 0, w * progress, h);
      ctx.clip();
      return 1;
    case "wipeRight":
      ctx.beginPath();
      ctx.rect(w * away, 0, w * progress, h);
      ctx.clip();
      return 1;
    case "wipeUp":
      ctx.beginPath();
      ctx.rect(0, 0, w, h * progress);
      ctx.clip();
      return 1;
    case "wipeDown":
      ctx.beginPath();
      ctx.rect(0, h * away, w, h * progress);
      ctx.clip();
      return 1;
    case "pushLeft":
      ctx.translate(-w * away, 0);
      return 1;
    case "pushRight":
      ctx.translate(w * away, 0);
      return 1;
    case "slideUp":
      ctx.translate(0, h * away);
      return 1;
    case "slideDown":
      ctx.translate(0, -h * away);
      return 1;
    case "zoom": {
      const scale = 0.6 + 0.4 * progress;
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      return progress;
    }
    case "blur":
      ctx.filter = `blur(${(away * 30).toFixed(1)}px)`;
      return progress;
    default:
      return 1;
  }
}

/* ------------------------------------------------------------------ layers */

/** The source rectangle after cropping, and after squaring off for a circle. */
export function croppedSource(w: number, h: number, transform: Transform): Box {
  const { crop } = transform;
  let sx = w * crop.left;
  let sy = h * crop.top;
  let sw = w * (1 - crop.left - crop.right);
  let sh = h * (1 - crop.top - crop.bottom);

  if (transform.shape === "circle") {
    // A circle has to come from a square, or the picture is stretched into the
    // mask rather than filling it.
    const side = Math.min(sw, sh);
    sx += (sw - side) / 2;
    sy += (sh - side) / 2;
    sw = side;
    sh = side;
  }
  return { x: sx, y: sy, w: sw, h: sh };
}

function sourceRect(image: CanvasImageSource, transform: Transform): Box {
  const { w, h } = sourceSize(image);
  return croppedSource(w, h, transform);
}

/** The layer's size on the canvas, before rotation and anchoring. */
function layerSize(project: Project, source: Box, transform: Transform, isBase: boolean) {
  const inset = isBase ? 1 - project.padding * 2 : 1;
  const availableW = project.width * inset * transform.scale * transform.scaleX;
  const availableH = project.height * inset * transform.scale * transform.scaleY;
  const fit = Math.min(availableW / source.w, availableH / source.h);
  return { w: source.w * fit, h: source.h * fit };
}

function pathFor(
  ctx: CanvasRenderingContext2D,
  box: Box,
  transform: Transform,
  unit: number,
) {
  ctx.beginPath();
  if (transform.shape === "circle") {
    ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
  } else if (transform.radius > 0) {
    ctx.roundRect(
      box.x,
      box.y,
      box.w,
      box.h,
      Math.min(transform.radius * unit, box.w / 2, box.h / 2),
    );
  } else {
    ctx.rect(box.x, box.y, box.w, box.h);
  }
}

/** Applies a mask by erasing everything outside it, with an optional feather. */
function applyMask(
  ctx: CanvasRenderingContext2D,
  mask: Clip["mask"],
  box: Box,
  unit: number,
) {
  if (mask.shape === "none") return;

  const mx = box.x + mask.x * box.w;
  const my = box.y + mask.y * box.h;
  const mw = mask.width * box.w;
  const mh = mask.height * box.h;

  ctx.save();
  ctx.globalCompositeOperation = mask.invert ? "destination-out" : "destination-in";
  if (mask.feather > 0) {
    // Feathering the mask edge means blurring the stencil itself, not the
    // picture — so a soft edge does not soften the content inside it.
    ctx.filter = `blur(${(mask.feather * unit).toFixed(1)}px)`;
  }
  ctx.translate(mx, my);
  ctx.rotate((mask.rotation * Math.PI) / 180);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  if (mask.shape === "ellipse") {
    ctx.ellipse(0, 0, mw / 2, mh / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.rect(-mw / 2, -mh / 2, mw, mh);
  }
  ctx.fill();
  ctx.restore();
}

interface LayerDraw {
  image: CanvasImageSource;
  transform: Transform;
  color: ColorGrade;
  effects: EffectInstance[];
  mask: Clip["mask"];
  isBase: boolean;
}

/**
 * Composites one picture layer.
 *
 * The layer is built on its own canvas first, because masks, glows and blend
 * modes all need to operate on the layer in isolation — compositing them
 * straight onto the frame would let them affect whatever is already beneath.
 */
export function drawLayer(
  ctx: CanvasRenderingContext2D,
  project: Project,
  layer: LayerDraw,
): void {
  const { image, transform, isBase } = layer;
  const source = sourceRect(image, transform);
  if (!(source.w > 0) || !(source.h > 0)) return;

  const size = layerSize(project, source, transform, isBase);
  if (!(size.w > 0) || !(size.h > 0)) return;

  const unit = project.height / REFERENCE_HEIGHT;
  const needsIsolation =
    layer.mask.shape !== "none" ||
    transform.blendMode !== "normal" ||
    overlayEffects(layer.effects).length > 0;

  const filter = [gradeToFilter(layer.color), effectsToFilter(layer.effects)]
    .filter(Boolean)
    .join(" ");

  const paint = (target: CanvasRenderingContext2D, box: Box) => {
    target.save();
    if (filter) target.filter = filter;
    pathFor(target, box, transform, unit);
    target.clip();
    target.drawImage(
      image,
      source.x,
      source.y,
      source.w,
      source.h,
      box.x,
      box.y,
      box.w,
      box.h,
    );
    target.restore();
  };

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity));
  ctx.globalCompositeOperation = transform.blendMode === "normal" ? "source-over" : transform.blendMode;

  // Anchor, rotate and flip about the anchor point rather than the centre, so
  // rotating a corner-pinned overlay pivots where the user put the pin.
  const cx = transform.x * project.width;
  const cy = transform.y * project.height;
  ctx.translate(cx, cy);
  if (transform.rotation !== 0) ctx.rotate((transform.rotation * Math.PI) / 180);
  if (transform.flipH || transform.flipV) {
    ctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
  }

  const box: Box = {
    x: -size.w * transform.anchorX,
    y: -size.h * transform.anchorY,
    w: size.w,
    h: size.h,
  };

  if (transform.shadow > 0) {
    // Drawn as a filled shape behind the layer rather than as a shadow on the
    // image: a shadow on `drawImage` is recomputed at full blur radius every
    // frame, which is the most expensive single thing a canvas can do.
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = transform.shadow * unit;
    ctx.shadowOffsetY = transform.shadow * unit * 0.3;
    ctx.fillStyle = "#000";
    pathFor(ctx, box, transform, unit);
    ctx.fill();
    ctx.restore();
  }

  if (!needsIsolation) {
    paint(ctx, box);
    ctx.restore();
    return;
  }

  const layerCanvas = getScratch("layer", project.width, project.height);
  const layerCtx = layerCanvas.getContext("2d");
  if (!layerCtx) {
    ctx.restore();
    return;
  }
  layerCtx.clearRect(0, 0, layerCanvas.width, layerCanvas.height);

  // The isolated canvas is in frame space, so shift the box to the middle of
  // it, composite there, then blit the whole thing back through the transform.
  const isolated: Box = {
    x: project.width / 2 + box.x,
    y: project.height / 2 + box.y,
    w: box.w,
    h: box.h,
  };
  paint(layerCtx, isolated);
  drawOverlayEffects(layerCtx, overlayEffects(layer.effects), isolated, unit);
  applyMask(layerCtx, layer.mask, isolated, unit);

  ctx.drawImage(layerCanvas, -project.width / 2, -project.height / 2);
  ctx.restore();
}

/* ---------------------------------------------------------------- geometry */

/**
 * Where a clip lands on the canvas, in project pixels.
 *
 * Exported because the monitor's selection handles have to sit exactly on the
 * drawn layer. Any second implementation of this maths would drift from the
 * renderer the first time either changed — the same failure the shared
 * `drawFrame` exists to prevent, one level down.
 */
export interface ClipBox {
  /** The point the layer rotates about, in project pixels. */
  cx: number;
  cy: number;
  /** The box relative to that point, before rotation. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;

function textMetrics(project: Project, clip: Clip): { w: number; h: number } {
  const style = clip.text;
  if (!style) return { w: 0, h: 0 };
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  const unit = project.height / REFERENCE_HEIGHT;
  const fontSize = style.fontSize * unit * clip.transform.scale;
  const lines = style.content.split("\n");
  if (!measureCtx) return { w: fontSize * 6, h: fontSize * lines.length * style.lineHeight };
  measureCtx.font = `${style.italic ? "italic " : ""}${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  const width = Math.max(...lines.map((l) => measureCtx!.measureText(l).width), 1);
  return { w: width, h: lines.length * fontSize * style.lineHeight };
}

export function clipBox(
  project: Project,
  clip: Clip,
  source: { width: number; height: number } | null,
  isBase: boolean,
): ClipBox | null {
  const t = clip.transform;
  const cx = t.x * project.width;
  const cy = t.y * project.height;

  if (clip.kind === "text") {
    const { w, h } = textMetrics(project, clip);
    return { cx, cy, x: -w / 2, y: -h / 2, w, h, rotation: t.rotation };
  }

  if (clip.kind === "shape") {
    const w = project.width * 0.3 * t.scale * t.scaleX;
    const h = project.height * 0.3 * t.scale * t.scaleY;
    return { cx, cy, x: -w / 2, y: -h / 2, w, h, rotation: t.rotation };
  }

  if (!source || source.width <= 0 || source.height <= 0) return null;
  const cropped = croppedSource(source.width, source.height, t);
  if (!(cropped.w > 0) || !(cropped.h > 0)) return null;
  const size = layerSize(project, cropped, t, isBase);
  if (!(size.w > 0) || !(size.h > 0)) return null;
  return {
    cx,
    cy,
    x: -size.w * t.anchorX,
    y: -size.h * t.anchorY,
    w: size.w,
    h: size.h,
    rotation: t.rotation,
  };
}

/** True when a point in project pixels falls inside the clip's drawn box. */
export function hitTest(box: ClipBox, px: number, py: number): boolean {
  const radians = (-box.rotation * Math.PI) / 180;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const lx = dx * Math.cos(radians) - dy * Math.sin(radians);
  const ly = dx * Math.sin(radians) + dy * Math.cos(radians);
  return lx >= box.x && lx <= box.x + box.w && ly >= box.y && ly <= box.y + box.h;
}

/* -------------------------------------------------------------------- text */

function drawText(
  ctx: CanvasRenderingContext2D,
  project: Project,
  clip: Clip,
  style: TextStyle,
  localTime: number,
) {
  const unit = project.height / REFERENCE_HEIGHT;
  const t = clip.transform;

  // Animation presets are expressed as offsets applied on top of the clip's own
  // transform, so a user can still position and scale an animated title.
  let alpha = t.opacity;
  let offsetX = 0;
  let offsetY = 0;
  let extraScale = 1;
  let visibleChars = style.content.length;

  const animation = clip.textAnimation ?? "none";
  if (animation !== "none") {
    const inDuration = Math.min(0.6, clip.duration / 2);
    const p = Math.max(0, Math.min(1, localTime / inDuration));
    const eased = EASE(p);
    switch (animation) {
      case "fade":
        alpha *= eased;
        break;
      case "slideUp":
        alpha *= eased;
        offsetY = (1 - eased) * project.height * 0.06;
        break;
      case "slideLeft":
        alpha *= eased;
        offsetX = (1 - eased) * project.width * 0.06;
        break;
      case "typewriter":
        visibleChars = Math.ceil(style.content.length * p);
        break;
      case "pop":
        extraScale = 0.7 + 0.3 * eased + Math.sin(p * Math.PI) * 0.08;
        alpha *= eased;
        break;
      case "scale":
        extraScale = 0.85 + 0.15 * eased;
        alpha *= eased;
        break;
    }
  }

  const content = style.content.slice(0, visibleChars);
  const lines = content.split("\n");
  const fontSize = style.fontSize * unit * t.scale * extraScale;
  const lineHeight = fontSize * style.lineHeight;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.globalCompositeOperation =
    t.blendMode === "normal" ? "source-over" : t.blendMode;
  ctx.translate(t.x * project.width + offsetX, t.y * project.height + offsetY);
  if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180);

  const weight = style.italic ? `italic ${style.fontWeight}` : `${style.fontWeight}`;
  ctx.font = `${weight} ${fontSize}px ${style.fontFamily}`;
  ctx.textAlign = style.align;
  ctx.textBaseline = "middle";
  if ("letterSpacing" in ctx) {
    (ctx as unknown as { letterSpacing: string }).letterSpacing =
      `${style.letterSpacing * unit}px`;
  }

  const totalHeight = lines.length * lineHeight;
  const startY = -totalHeight / 2 + lineHeight / 2;

  if (style.background) {
    const pad = style.backgroundPadding * unit;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
    const bx = style.align === "center" ? -widest / 2 : style.align === "right" ? -widest : 0;
    ctx.save();
    ctx.fillStyle = style.background;
    ctx.beginPath();
    ctx.roundRect(bx - pad, startY - lineHeight / 2 - pad, widest + pad * 2, totalHeight + pad * 2, pad / 2);
    ctx.fill();
    ctx.restore();
  }

  if (style.shadowBlur > 0) {
    ctx.shadowBlur = style.shadowBlur * unit;
    ctx.shadowColor = style.shadowColor;
  }

  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    if (style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth * unit;
      ctx.strokeStyle = style.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(line, 0, y);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, 0, y);

    if (style.underline) {
      const width = ctx.measureText(line).width;
      const ux = style.align === "center" ? -width / 2 : style.align === "right" ? -width : 0;
      ctx.fillRect(ux, y + fontSize * 0.42, width, Math.max(1, fontSize * 0.06));
    }
  });

  ctx.restore();
}

/* ------------------------------------------------------------------ shapes */

function drawShape(
  ctx: CanvasRenderingContext2D,
  project: Project,
  clip: Clip,
  shape: ShapeStyle,
) {
  const t = clip.transform;
  const unit = project.height / REFERENCE_HEIGHT;
  const w = project.width * 0.3 * t.scale * t.scaleX;
  const h = project.height * 0.3 * t.scale * t.scaleY;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, t.opacity));
  ctx.globalCompositeOperation = t.blendMode === "normal" ? "source-over" : t.blendMode;
  ctx.translate(t.x * project.width, t.y * project.height);
  if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180);

  ctx.beginPath();
  switch (shape.kind) {
    case "ellipse":
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "line":
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      break;
    case "triangle":
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      break;
    case "arrow":
      ctx.moveTo(-w / 2, -h / 8);
      ctx.lineTo(w / 6, -h / 8);
      ctx.lineTo(w / 6, -h / 3);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(w / 6, h / 3);
      ctx.lineTo(w / 6, h / 8);
      ctx.lineTo(-w / 2, h / 8);
      ctx.closePath();
      break;
    case "star": {
      const points = Math.max(3, Math.round(shape.points));
      const outer = Math.min(w, h) / 2;
      const inner = outer * 0.45;
      for (let i = 0; i < points * 2; i += 1) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = (i * Math.PI) / points - Math.PI / 2;
        const px = Math.cos(angle) * radius;
        const py = Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    default:
      if (shape.cornerRadius > 0) {
        ctx.roundRect(-w / 2, -h / 2, w, h, shape.cornerRadius * unit);
      } else {
        ctx.rect(-w / 2, -h / 2, w, h);
      }
  }

  if (shape.kind !== "line") {
    ctx.fillStyle = shape.fill;
    ctx.fill();
  }
  if (shape.strokeWidth > 0 || shape.kind === "line") {
    ctx.lineWidth = Math.max(1, shape.strokeWidth * unit);
    ctx.strokeStyle = shape.stroke;
    ctx.lineCap = "round";
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- captions */

function drawCaptions(ctx: CanvasRenderingContext2D, project: Project, time: number) {
  if (!project.captionsEnabled) return;
  const cue = project.captions.find((c) => time >= c.start && time < c.end);
  if (!cue) return;

  const style = project.captionStyle;
  const unit = project.height / REFERENCE_HEIGHT;
  const fontSize = style.fontSize * unit;
  const lines = cue.text.split("\n");
  const lineHeight = fontSize * 1.25;

  ctx.save();
  ctx.font = `600 ${fontSize}px ${style.fontFamily}`;
  ctx.textAlign = style.align;
  ctx.textBaseline = "middle";

  const x =
    style.align === "center"
      ? project.width / 2
      : style.align === "right"
        ? project.width * 0.92
        : project.width * 0.08;
  const baseY = project.height * style.y - ((lines.length - 1) * lineHeight) / 2;

  if (style.background) {
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
    const pad = fontSize * 0.4;
    const bx = style.align === "center" ? x - widest / 2 : style.align === "right" ? x - widest : x;
    ctx.fillStyle = style.background;
    ctx.beginPath();
    ctx.roundRect(
      bx - pad,
      baseY - lineHeight / 2 - pad / 2,
      widest + pad * 2,
      lines.length * lineHeight + pad,
      pad / 2,
    );
    ctx.fill();
  }

  lines.forEach((line, i) => {
    const y = baseY + i * lineHeight;
    if (style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth * unit;
      ctx.strokeStyle = style.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

/* ------------------------------------------------------------------ guides */

function drawGuides(ctx: CanvasRenderingContext2D, project: Project) {
  const g = project.guides;
  const w = project.width;
  const h = project.height;
  ctx.save();
  ctx.lineWidth = Math.max(1, h / 900);

  if (g.grid) {
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    for (let i = 1; i < 12; i += 1) {
      ctx.beginPath();
      ctx.moveTo((w / 12) * i, 0);
      ctx.lineTo((w / 12) * i, h);
      ctx.stroke();
    }
    for (let i = 1; i < 7; i += 1) {
      ctx.beginPath();
      ctx.moveTo(0, (h / 7) * i);
      ctx.lineTo(w, (h / 7) * i);
      ctx.stroke();
    }
  }
  if (g.thirds) {
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    for (const f of [1 / 3, 2 / 3]) {
      ctx.beginPath();
      ctx.moveTo(w * f, 0);
      ctx.lineTo(w * f, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, h * f);
      ctx.lineTo(w, h * f);
      ctx.stroke();
    }
  }
  if (g.center) {
    ctx.strokeStyle = "rgba(255,80,80,0.6)";
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
  // 90% action safe and 80% title safe are the broadcast conventions.
  const safe = (fraction: number, color: string) => {
    const inset = (1 - fraction) / 2;
    ctx.strokeStyle = color;
    ctx.strokeRect(w * inset, h * inset, w * fraction, h * fraction);
  };
  if (g.actionSafe) safe(0.9, "rgba(255,255,255,0.35)");
  if (g.titleSafe) safe(0.8, "rgba(255,220,80,0.45)");
  ctx.restore();
}

/* ------------------------------------------------------------------- frame */

/** Seconds into the asset that a clip shows at a given timeline time. */
export function assetTimeFor(clip: Clip, time: number): number {
  if (clip.freeze) return clip.inPoint;
  const local = (time - clip.start) * clip.speed;
  if (clip.reversed) {
    return clip.inPoint + clip.duration * clip.speed - local;
  }
  return clip.inPoint + local;
}

/** Clips covering `time`, bottom track first — i.e. compositing order. */
export function visibleClips(project: Project, time: number): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  const anySolo = project.tracks.some((t) => t.solo);
  for (const track of project.tracks) {
    if (track.hidden) continue;
    if (anySolo && !track.solo) continue;
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      if (time >= clip.start && time < clip.start + clip.duration) out.push({ track, clip });
    }
  }
  return out;
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  time: number,
  resolve: FrameResolver,
  options: DrawOptions = {},
): void {
  paintBackground(ctx, project);

  const visible = visibleClips(project, time).filter(({ track }) => track.kind === "video");
  let baseDrawn = false;

  for (const { clip: rawClip } of visible) {
    const localTime = time - rawClip.start;
    const clip = clipAt(rawClip, localTime);
    const transition = transitionAt(clip, localTime);

    ctx.save();
    let alpha = 1;
    if (transition) alpha = applyTransition(ctx, transition, project);
    ctx.globalAlpha = alpha;

    if (clip.kind === "text" && clip.text) {
      drawText(ctx, project, clip, clip.text, localTime);
    } else if (clip.kind === "shape" && clip.shape) {
      drawShape(ctx, project, clip, clip.shape);
    } else if (clip.kind === "media" && clip.assetId) {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (asset?.hasVideo) {
        let image = resolve(clip, asset);
        if (image) {
          if (clip.chroma.enabled) image = applyChromaKey(image, clip.chroma) ?? image;
          image = applyPixelEffects(image, clip.effects.filter((e) => e.enabled));
          const isBase = !baseDrawn;
          baseDrawn = true;
          drawLayer(ctx, project, {
            image,
            transform: clip.transform,
            color: isNeutralGrade(clip.color) ? clip.color : clip.color,
            effects: clip.effects.filter((e) => e.enabled),
            mask: clip.mask,
            isBase,
          });
        }
      }
    }

    // A dip to black or white floods the frame rather than fading the layer,
    // so it reads the same whatever is underneath.
    if (transition && (transition.transition.type === "fadeToBlack" || transition.transition.type === "fadeToWhite")) {
      ctx.globalAlpha = 1 - alpha;
      ctx.fillStyle = transition.transition.type === "fadeToBlack" ? "#000" : "#fff";
      ctx.fillRect(0, 0, project.width, project.height);
    }

    ctx.restore();
  }

  drawCaptions(ctx, project, time);
  if (options.guides) drawGuides(ctx, project);
}
