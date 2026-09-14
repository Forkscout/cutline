/**
 * What is known about image models: whose licence lets their pictures go into
 * client work, and a size to ask them for. Shared by the server, the page and
 * the agent's tools, so a warning reads the same everywhere. No DOM.
 */

export interface Licence {
  name: string;
  /** Its pictures may be used in commercial and client work. */
  commercial: boolean;
}

/** Word-ish boundaries that treat _ and . as separators, as model file names use them. */
const size = (n: string) => `(?:^|[^0-9a-z])${n}(?:[^0-9a-z]|$)`;

/** Open-weights families by name, most specific first. */
const FAMILIES: [RegExp, Licence][] = [
  [new RegExp(`flux[._\\s-]*2.*klein.*${size("9b")}`, "i"), { name: "FLUX Non-Commercial License", commercial: false }],
  [/flux[._\s-]*2.*klein/i, { name: "Apache 2.0", commercial: true }],
  [/flux[._\s-]*2.*dev/i, { name: "FLUX Non-Commercial License", commercial: false }],
  [/flux[._\s-]*1.*dev/i, { name: "FLUX.1 [dev] Non-Commercial License", commercial: false }],
  [/flux[._\s-]*1.*schnell/i, { name: "Apache 2.0", commercial: true }],
  [/z[._\s-]*image/i, { name: "Apache 2.0", commercial: true }],
  [/qwen[._\s-]*image/i, { name: "Apache 2.0", commercial: true }],
];

/**
 * The licence of a model running on this machine, when its family is known.
 * A hosted model's pictures come under the service's terms instead, so none is
 * claimed for one.
 */
export function licenceOf(model: string, local: boolean): Licence | null {
  if (!local || !model) return null;
  return FAMILIES.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

/** A warning to show when a model's pictures are not for client work, or null. */
export function licenceWarning(model: string, local: boolean): string | null {
  const licence = licenceOf(model, local);
  if (!licence || licence.commercial) return null;
  return `${model} is under the ${licence.name}: its images are not for commercial or client work. Z-Image Turbo, FLUX.2 [klein] 4B and Qwen-Image are Apache 2.0.`;
}

/**
 * A size to ask a model for, in the sequence's shape: the long side about
 * 1536 px, both sides multiples of 64, which every local model accepts.
 * Placing a still covers the frame whatever size it came back at.
 */
export function imageSizeFor(frame: { width: number; height: number }, longSide = 1536): { width: number; height: number } {
  const ratio = frame.width / frame.height;
  const round = (n: number) => Math.max(256, Math.round(n / 64) * 64);
  return ratio >= 1 ? { width: round(longSide), height: round(longSide / ratio) } : { width: round(longSide * ratio), height: round(longSide) };
}
