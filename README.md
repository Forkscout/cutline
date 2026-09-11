# Cutline

[![License: MIT](https://img.shields.io/badge/License-MIT-c3f53c.svg)](LICENSE)

A video editor that runs in the browser, with recording built in.

Capture your screen, your camera and your microphone in one take. Each one is
written to its own file on a shared clock — so afterwards you can re-time, mute,
crop or replace any of them without disturbing the others. Nothing leaves your
machine: recordings, imports and projects are ordinary files under `~/Cutline`,
and the export runs locally.

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
  memory nor disappears if the tab dies — then moved into `~/Cutline` when the
  take ends, and deleted from the browser only once every byte has arrived
- **A library** to play back, download and delete past takes

## What does not work yet

No audio effects or mixer, stabilisation, motion tracking,
multicam, LUTs, curves or colour wheels, batch export, proxies, collaboration,
cloud or plugins. ProRes, DNxHR, Dolby Vision and native plugins are not
reachable from a browser at all. See [`CLAUDE.md`](CLAUDE.md).

## Running it

Needs [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

Then open http://localhost:5310. That starts two things together: the web app,
and a small local server that keeps your projects, recordings and imported
media as ordinary files in `~/Cutline` — visible, backed up by whatever backs up
your home folder, and not one "clear browsing data" away from gone. The server
listens on 127.0.0.1 only, and every request needs a per-run token.

`bun run start` builds the app and serves everything from the one process.

### Auto-captions

Right-click anything with sound — a clip on the timeline or an item in the
media pool — and choose **Generate captions**. The captions land where that
clip is heard, and captions under other clips are left alone. They show in a
Captions lane under the timeline's ruler — click one to go there, double-click
to edit it — and on the picture while the playhead is inside one. The Captions
panel does the same with a choice of language.

Captions and the transcript are two things. The transcript is every word with
its own time, kept with the media file; captions are lines made from it for
viewers. Editing or deleting captions leaves the transcript alone, and it is
the transcript an agent reads (the `transcript` tool) to time a cut, a title or
an animation to a word.

Transcription goes through a speech-to-text service with an OpenAI-compatible
API — hosted with a key, or on your own machine. whisper.cpp's server is free
and private:

```bash
whisper-server -m ~/.cache/whisper-cpp/ggml-medium.bin --inference-path /v1/audio/transcriptions --convert -l auto --port 8178
```

Then press Connect in the Captions panel (the address is filled in). Asking for
captions before a service is connected opens that panel. LM Studio has no transcription endpoint yet, so it cannot
serve this.

### Letting an agent edit

Cutline is also an MCP server. With it running, register it with Claude Code
once:

```bash
claude mcp add --transport http cutline http://127.0.0.1:5311/mcp --header "Authorization: Bearer $(cat ~/Cutline/mcp-token)"
```

Open a project and ask. The agent edits the project open in your editor through
the same actions the interface uses, so you watch each change land, and its
whole turn is one undo step. It can render any frame, check the audio for gaps
and clipping, and export the finished video to `~/Cutline` — and it is told to
look before it reports.

**Chrome or Edge.** The recorder streams to disk through `createSyncAccessHandle`,
which only exists in a worker, and the exporter encodes with WebCodecs. Neither
has a fallback here, and pretending otherwise would just fail later and less
clearly.

Built with React 19, TypeScript, Vite, Tailwind v4, shadcn/ui and
[mediabunny](https://mediabunny.dev) for demuxing, decoding and muxing.

## Checking your work

```bash
bun run typecheck
```

Two harnesses run in the browser and need no permissions — a canvas stream and
an oscillator are indistinguishable from a camera and a microphone as far as
`MediaRecorder` is concerned:

- **`/dev-check.html`** covers the recorder: chunk ordering, the OPFS worker,
  track offsets, pause accounting, reading files back.
- **`/dev-editor-check.html`** covers the edit model, linked clips, subtitles,
  moving a take to the server, import and export — then **decodes the file it just exported and reads its
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

Run `bun run typecheck` and both harnesses before opening a PR.

## Licence

[MIT](LICENSE).
