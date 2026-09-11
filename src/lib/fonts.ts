/**
 * Web fonts for text drawn on canvases: the preview, the frames an agent
 * renders, and the export.
 *
 * Canvas text uses a face only once it is loaded — a family named but not yet
 * fetched silently falls back — and the export worker has no document, so it
 * never sees the page's fonts at all. Export used to draw every web font in a
 * fallback while the preview showed the real one. So the page fetches each
 * family's files once, registers them for itself, and hands the same bytes to
 * the worker, which registers them before it draws a frame.
 *
 * Families come from Google Fonts, where the app's own interface faces come
 * from already. A family installed on this machine is used as it is.
 */

export interface FontFile {
  family: string;
  weight: string;
  style: string;
  unicodeRange?: string;
  data: ArrayBuffer;
}

/** Faces every Mac or PC has, and generic names: nothing to fetch. */
const LOCAL = new Set([
  "avenir next", "avenir", "helvetica neue", "helvetica", "arial", "georgia", "times new roman", "times", "baskerville",
  "futura", "gill sans", "menlo", "courier new", "verdana", "system-ui", "sans-serif", "serif", "monospace", "cursive",
]);

const families = new Map<string, Promise<FontFile[]>>();

function parseCss(css: string): { weight: string; style: string; unicodeRange?: string; url: string }[] {
  const faces: { weight: string; style: string; unicodeRange?: string; url: string }[] = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const url = /url\((['"]?)([^)'"]+)\1\)\s*format\(['"]?woff2/.exec(block)?.[2] ?? /url\((['"]?)([^)'"]+)\1\)/.exec(block)?.[2];
    if (!url) continue;
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]?.trim();
    faces.push({
      weight: /font-weight:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? "400",
      style: /font-style:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? "normal",
      url,
      ...(range ? { unicodeRange: range } : {}),
    });
  }
  return faces;
}

async function fetchFamily(family: string): Promise<FontFile[]> {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  // A variable font answers a weight range; a static one only its own weights,
  // and the plain request always answers with the regular.
  let css: string | null = null;
  for (const query of [`${name}:ital,wght@0,100..900;1,100..900`, `${name}:wght@100..900`, name]) {
    const response = await fetch(`https://fonts.googleapis.com/css2?family=${query}&display=swap`).catch(() => null);
    if (response?.ok) {
      css = await response.text();
      break;
    }
  }
  if (!css) return [];
  const files = await Promise.all(
    parseCss(css).map(async (face) => {
      const response = await fetch(face.url).catch(() => null);
      if (!response?.ok) return null;
      return { family, weight: face.weight, style: face.style, data: await response.arrayBuffer(), ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}) };
    }),
  );
  return files.filter((f): f is FontFile => f !== null);
}

/** Registers files with a FontFaceSet — the document's, or a worker's — and waits for them. */
export async function registerFonts(set: FontFaceSet, files: FontFile[]): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      const face = new FontFace(f.family, f.data, {
        weight: f.weight,
        style: f.style,
        ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
      });
      set.add(face);
      await face.load().catch(() => {});
    }),
  );
}

/**
 * Loads each web family for this page and returns its files, for a worker.
 * Offline, or for a family Google does not have, it returns nothing and the
 * text falls back — as it would have anyway.
 */
export async function loadFonts(names: string[]): Promise<FontFile[]> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n && !LOCAL.has(n.toLowerCase())))];
  const loaded = await Promise.all(
    wanted.map((family) => {
      let pending = families.get(family);
      if (!pending) {
        pending = fetchFamily(family).then(async (files) => {
          if (typeof document !== "undefined") await registerFonts(document.fonts, files);
          return files;
        });
        families.set(family, pending);
      }
      return pending;
    }),
  );
  return loaded.flat();
}
