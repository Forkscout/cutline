# Cutline

[![License: MIT](https://img.shields.io/badge/License-MIT-c3f53c.svg)](LICENSE)

A video editor that runs in the browser, with recording built in.

Capture your screen, your camera and your microphone in one take. Each one is
written to its own file on a shared clock — so afterwards you can re-time, mute,
crop or replace any of them without disturbing the others. Nothing is uploaded;
recordings live in the browser's private file system and the export runs on your
own machine.

## What works today

Record, edit, export — the whole loop, on your own machine, in one full-page
editor.

### Projects
Save, autosave, crash recovery, duplicate, delete. Media that has gone missing
between sessions is detected and named rather than rendering black.

### Media
Drag-and-drop or pick files — video, audio, images. Thumbnails, waveforms,
duration, resolution, codec, bins, search, sort, favourites.

### Timeline
Everything from one take stays **linked**: cut the picture and the voice is cut
with it, at the same instant, so lip sync cannot quietly drift. When you want
them apart, **Detach audio** — or unlink the whole take — and edit each freely.

Unlimited video and audio tracks. Move, trim, ripple trim, slip, split, ripple
delete, duplicate. Snapping to clip edges, markers and the playhead. Per-track
lock, hide, mute and solo. Drag clips between tracks. Waveforms drawn on audio
clips. Markers, in/out points, JKL shuttle.

### Layers
Click a layer in the preview to select it, drag it to move, pull a corner to
resize, an edge to stretch, or the handle above it to rotate — with snapping to
the centre, the thirds and the edges. Or set any of it numerically:
position, scale, stretch, rotation, anchor point, opacity, flip, crop, rounded
or circular framing, drop shadow, and all sixteen blend modes. Rectangle and
ellipse masks with feather and invert. Chroma key with similarity, smoothness
and spill suppression.

### Colour and effects
Exposure, brightness, contrast, highlights, shadows, whites, blacks, saturation,
vibrance, temperature, tint, hue, sharpen, fade. A stacked, reorderable effects
rack: blur, gaussian blur, sharpen, glow, film grain, vignette, pixelate,
posterize, black & white, sepia, invert, tint, chromatic aberration, scanlines.

### Motion
Keyframe any slider from the diamond beside it — linear, ease, ease-in,
ease-out or hold. Fourteen transitions in and out of every clip.

### Text, shapes and captions
Text layers with font, weight, size, tracking, leading, colour, stroke, shadow,
backing and six animation presets. Shape layers — rectangle, ellipse, line,
triangle, star, arrow. Captions written by hand or imported from SRT or WebVTT,
styled and burned in, exported back out.

### Monitoring
Histogram, luma waveform, RGB parade and vectorscope, measured off the program
monitor so they reflect every grade exactly as it will export. Grid, rule of
thirds, centre guides, action safe and title safe.

### Export
MP4/H.264 or WebM/VP9 with delivery presets for YouTube, Shorts, Reels and
TikTok, plus resolution, frame rate, quality and explicit bitrate — and an
in/out range. Encoded on your machine at around 4× realtime; nothing is
uploaded.

The preview and the exporter render through the same function, so the file you
get is the frame you approved.

### Recording

Start from what you want to capture — screen, camera, both, or just your voice —
and the right sources arm themselves. The camera rides over the screen in the
preview exactly as it will in the edit, so the framing decision is made once.

- **Screen, camera, microphone and system audio**, any combination, each to its
  own file on a shared clock
- **Device pickers**, frame rate and noise-suppression controls
- **Live level meters** that warn when a microphone has gone silent — while the
  take can still be saved, rather than after
- **Pause and resume**, with the paused spans recorded
- **Streamed to disk** as it records, so a long screen capture neither fills
  memory nor disappears if the tab dies
- **A library** to play back, download and delete past takes

## What does not work yet

No auto-captions, audio effects or mixer, stabilisation, motion tracking,
multicam, LUTs, curves or colour wheels, batch export, proxies, collaboration,
cloud or plugins. ProRes, DNxHR, Dolby Vision and native plugins are not
reachable from a browser at all. See [`CLAUDE.md`](CLAUDE.md).

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5310.

**Chrome or Edge.** The recorder streams to disk through `createSyncAccessHandle`,
which only exists in a worker, and the exporter encodes with WebCodecs. Neither
has a fallback here, and pretending otherwise would just fail later and less
clearly.

Built with React 19, TypeScript, Vite, Tailwind v4, shadcn/ui and
[mediabunny](https://mediabunny.dev) for demuxing, decoding and muxing.

## Checking your work

```bash
npm run typecheck
```

Two harnesses run in the browser and need no permissions — a canvas stream and
an oscillator are indistinguishable from a camera and a microphone as far as
`MediaRecorder` is concerned:

- **`/dev-check.html`** covers the recorder: chunk ordering, the OPFS worker,
  track offsets, pause accounting, reading files back.
- **`/dev-editor-check.html`** covers the edit model, linked clips, subtitles,
  import and export — then **decodes the file it just exported and reads its
  pixels**, checking that the background, the screen layer, the camera overlay,
  the text, the captions, an effect and a colour grade all actually arrived.

That last part is not belt-and-braces. The first export this project produced
was the right duration, the right codec and the right resolution, and entirely
blank. Nothing short of looking at the pixels would have caught it.

## Contributing

Issues and pull requests are welcome.

Two things worth knowing before you change rendering code, both explained at
length in [`CLAUDE.md`](CLAUDE.md):

1. **The preview and the exporter render through one function**, `drawFrame` in
   `src/editor/compositor.ts`. Effects go there and nowhere else — adding one to
   the preview alone is the bug that design exists to prevent.
2. **Clips recorded together are linked**, and every timeline edit propagates
   through the group. Split the picture without the sound and lip sync drifts
   silently.

Run `npm run typecheck` and both harnesses before opening a PR.

## Licence

[MIT](LICENSE).
