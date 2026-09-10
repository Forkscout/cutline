/**
 * Effect and colour definitions, and how they become drawing instructions.
 *
 * Almost everything here compiles down to a CSS filter string on the canvas
 * context. That is deliberate: `ctx.filter` is executed by the browser's own
 * compositor, on the GPU, and costs a fraction of what the equivalent
 * `getImageData` loop would. The handful of effects that genuinely cannot be
 * expressed that way — grain, vignette, scanlines, chroma key — are marked and
 * drawn separately.
 */

import type { ColorGrade, EffectInstance, EffectType } from "./types";

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface EffectSpec {
  type: EffectType;
  label: string;
  /** False when the effect needs its own drawing pass rather than a filter. */
  filterOnly: boolean;
  params: ParamSpec[];
}

const amount = (def: number, max = 100): ParamSpec => ({
  key: "amount",
  label: "Amount",
  min: 0,
  max,
  step: 1,
  default: def,
});

export const EFFECTS: EffectSpec[] = [
  { type: "blur", label: "Blur", filterOnly: true, params: [{ key: "radius", label: "Radius", min: 0, max: 60, step: 0.5, default: 6 }] },
  { type: "gaussianBlur", label: "Gaussian blur", filterOnly: true, params: [{ key: "radius", label: "Radius", min: 0, max: 120, step: 0.5, default: 14 }] },
  { type: "sharpen", label: "Sharpen", filterOnly: true, params: [amount(40)] },
  { type: "glow", label: "Glow", filterOnly: false, params: [amount(50), { key: "radius", label: "Radius", min: 1, max: 80, step: 1, default: 24 }] },
  { type: "grain", label: "Film grain", filterOnly: false, params: [amount(30)] },
  { type: "vignette", label: "Vignette", filterOnly: false, params: [amount(45), { key: "softness", label: "Softness", min: 1, max: 100, step: 1, default: 55 }] },
  { type: "pixelate", label: "Pixelate", filterOnly: false, params: [{ key: "size", label: "Block size", min: 2, max: 96, step: 1, default: 12 }] },
  { type: "posterize", label: "Posterize", filterOnly: false, params: [{ key: "levels", label: "Levels", min: 2, max: 32, step: 1, default: 6 }] },
  { type: "grayscale", label: "Black & white", filterOnly: true, params: [amount(100)] },
  { type: "sepia", label: "Sepia", filterOnly: true, params: [amount(80)] },
  { type: "invert", label: "Invert", filterOnly: true, params: [amount(100)] },
  { type: "tint", label: "Tint", filterOnly: false, params: [amount(35), { key: "hue", label: "Hue", min: 0, max: 360, step: 1, default: 210 }] },
  { type: "chromaticAberration", label: "Chromatic aberration", filterOnly: false, params: [amount(20, 60)] },
  { type: "scanlines", label: "Scanlines", filterOnly: false, params: [amount(30), { key: "spacing", label: "Spacing", min: 2, max: 24, step: 1, default: 4 }] },
];

export function effectSpec(type: EffectType): EffectSpec | undefined {
  return EFFECTS.find((e) => e.type === type);
}

export function defaultParams(type: EffectType): Record<string, number> {
  const spec = effectSpec(type);
  if (!spec) return {};
  return Object.fromEntries(spec.params.map((p) => [p.key, p.default]));
}

export function createEffect(type: EffectType): EffectInstance {
  return { id: crypto.randomUUID(), type, enabled: true, params: defaultParams(type) };
}

/* ------------------------------------------------------------------ colour */

export function isNeutralGrade(color: ColorGrade): boolean {
  return Object.values(color).every((v) => v === 0);
}

/**
 * Colour correction as a CSS filter chain.
 *
 * Not every control maps cleanly — `highlights`, `shadows`, `whites` and
 * `blacks` really want per-pixel curves — so they are folded into brightness
 * and contrast in the direction a colourist would expect. It is an
 * approximation, and an honest one: the alternative was leaving the controls
 * out entirely or paying a `getImageData` pass on every frame.
 */
export function gradeToFilter(color: ColorGrade): string {
  const parts: string[] = [];

  const exposure = 1 + color.exposure / 100;
  const brightness = 1 + color.brightness / 100 + color.whites / 400 - color.blacks / 400;
  const combined = exposure * brightness;
  if (Math.abs(combined - 1) > 0.001) parts.push(`brightness(${combined.toFixed(4)})`);

  const contrast = 1 + color.contrast / 100 + (color.shadows < 0 ? -color.shadows / 400 : 0) - color.fade / 300;
  if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${Math.max(0, contrast).toFixed(4)})`);

  // Vibrance is saturation with less effect on already-saturated colour; a
  // filter chain cannot express that, so it contributes at a reduced weight.
  const saturation = 1 + color.saturation / 100 + color.vibrance / 200;
  if (Math.abs(saturation - 1) > 0.001) parts.push(`saturate(${Math.max(0, saturation).toFixed(4)})`);

  // Temperature and tint ride on hue-rotate: warm turns toward orange, cool
  // toward blue, and tint pushes green/magenta.
  const hue = color.hue + color.temperature * -0.28 + color.tint * 0.22;
  if (Math.abs(hue) > 0.01) parts.push(`hue-rotate(${hue.toFixed(2)}deg)`);

  if (color.sharpen > 0) parts.push(`contrast(${(1 + color.sharpen / 300).toFixed(4)})`);
  if (color.highlights !== 0) parts.push(`brightness(${(1 + color.highlights / 500).toFixed(4)})`);

  return parts.join(" ");
}

/** The filter contribution of the effects that are pure filters. */
export function effectsToFilter(effects: EffectInstance[]): string {
  const parts: string[] = [];
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const p = effect.params;
    switch (effect.type) {
      case "blur":
        parts.push(`blur(${(p.radius ?? 0).toFixed(2)}px)`);
        break;
      case "gaussianBlur":
        parts.push(`blur(${(p.radius ?? 0).toFixed(2)}px)`);
        break;
      case "sharpen":
        // No sharpen primitive exists; local contrast is the honest stand-in.
        parts.push(`contrast(${(1 + (p.amount ?? 0) / 250).toFixed(4)})`);
        break;
      case "grayscale":
        parts.push(`grayscale(${((p.amount ?? 0) / 100).toFixed(3)})`);
        break;
      case "sepia":
        parts.push(`sepia(${((p.amount ?? 0) / 100).toFixed(3)})`);
        break;
      case "invert":
        parts.push(`invert(${((p.amount ?? 0) / 100).toFixed(3)})`);
        break;
      default:
        break;
    }
  }
  return parts.join(" ");
}

/** Effects needing their own pass, in the order they should be drawn. */
export function overlayEffects(effects: EffectInstance[]): EffectInstance[] {
  const order: EffectType[] = [
    "pixelate",
    "posterize",
    "chromaticAberration",
    "glow",
    "tint",
    "grain",
    "scanlines",
    "vignette",
  ];
  return effects
    .filter((e) => e.enabled && order.includes(e.type))
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}
