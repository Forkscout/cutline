# Roadmap

"Best" here does not mean finishing the 862-item feature list. Cutline is not
competing with Premiere; it is competing with the tools people actually reach
for when they need to explain something on screen — Loom, Screen Studio,
Descript, Tella. Those win on a handful of things done extremely well, and lose
nothing by not having a vectorscope.

So this is ordered by what changes the outcome, not by what fills the matrix.

---

## Decide now, or lose the option

Two of these are cheap today and impossible to retrofit later. They come first
for that reason alone.

### 1. Record a cursor track

**This is the single most important item on the page.**

The feature that makes a screen recording look professional is automatic
zoom — the frame pushing in on what the cursor is doing and pulling back when
it stops. Screen Studio is built on it. Cutline could do the compositing part
today: the zoom is just a keyframed `transform.scale` and `transform.x/y`,
which already exist and already export correctly.

What is missing is the data. Cursor position and click events have to be
captured **while recording**, sampled against the same clock as everything
else, and written as a fourth track. Nothing recovers that afterwards — a
finished screen capture is pixels, and finding the pointer in them is a
computer-vision problem nobody should have to solve.

Every take recorded before this lands can never have auto-zoom. Every take
after it can, whenever the feature is written.

The capture side is small: a `pointermove` and `pointerdown` listener is not
enough (the page only sees its own window), so this needs the
`CaptureController`/`getDisplayMedia` metadata where available, and otherwise a
documented limitation. Worth investigating properly before building on it.

### 2. A local server — decided

There is one now: a Hono server on Bun, bound to 127.0.0.1, that owns projects
on disk in `~/Cutline`. It sits between the two options this item used to
weigh — the architecture of a server, without a cloud.

It is the right step even if Cutline becomes a hosted product in the mould of
Veed, because it is the same shape — client, API, storage — with localhost as
the host. Staying browser-only would have been the dead end: a hosted version
would have needed the data layer rewritten from scratch. What keeps that
promise cheap is four rules, recorded in `CLAUDE.md` and worth keeping true:
storage behind an interface, a workspace id in every path, no project state
held in server memory, and one authentication seam.

What a hosted version would still have to add, honestly: accounts and billing,
object storage and a database behind `ProjectStore`, share links with hosted
playback and the transcoding and egress that implies, collaboration, and a
render queue for machines that cannot export in the browser. The README's
"Chrome or Edge only" line would also need re-testing against current Safari
and Firefox before competing on reach.

One thing to keep even then: client-side export and in-browser models as the
default. The user's machine doing the rendering and transcription is a cost
advantage a server-rendering competitor does not have.

Next in this direction: move recordings and imported media onto the server, then
put the MCP endpoint at `/mcp` in the same process.

---

## Correctness and risk

Six of the seven items that were here are done. What follows is what they turned
into, kept because the reasoning is the part worth reading.

### Done

- **Export runs in a worker.** `export-worker.ts` does the decode, composite and
  encode; the main thread only mixes audio and relays progress. The audio mix
  stays put because `OfflineAudioContext` is not exposed to workers, and it
  crosses the boundary as planar float32 rather than as an `AudioBuffer`, which
  cannot be transferred.
- **There is an error boundary.** It snapshots the live project to the recovery
  slot at the moment of the crash, before rendering anything, and offers the
  document as a downloadable file.
- **Proxies.** Anything taller than 1200px gets a 720p VP8 transcode on import.
  Playback reads it; the exporter never does.
- **Chroma key runs on the GPU.** A WebGL2 fragment shader replaced the
  `getImageData` loop, which cost 10–20 ms a frame at 1080p. The CPU path is
  still there for contexts without WebGL2.
- **Cross-tab autosave lock.** A `BroadcastChannel` decides which tab writes;
  the others open read-only and say so, with a deliberate "take over".
- **Timeline keyboard navigation.** Clips are focus targets; Alt+arrows move the
  selection along a track or between tracks, `,`/`.` nudge by a frame, Escape
  deselects. The bare arrows still step frames.

### Still open

- **Long recordings are still unmeasured.** `/dev-stress-check.html` exists and
  records a minute of 1440p, then reports write throughput, heap growth against
  file size, storage headroom, proxy ratio, and whether the far end of the file
  can be seeked — but it has not been run against a real multi-gigabyte take.
  It refuses to run in a background tab, because a throttled tab makes every one
  of those numbers wrong by an order of magnitude while still looking like a
  result.

## What would actually make it win

For the people who record their screen to explain something.

### Auto-captions

Already the planned next AI feature, and the highest-leverage one — not because
captions matter most on their own, but because the transcript unlocks the two
items below. Whisper runs in the browser via transformers.js, or locally
through the models already cached on this machine.

### Text-based editing

Edit the transcript, and the timeline follows. Delete a sentence, the video
loses it. This is what makes Descript feel unlike an editor, and for talking-head
and screen content it is faster than any timeline.

Depends entirely on captions landing first.

### Silence and filler-word removal

The single biggest time-saver for this kind of footage. Detect runs below a
threshold, propose the cuts, let the user accept them as a batch. The audio
peaks are already computed at import, so the detection half is nearly free.

### Auto-zoom and cursor smoothing

See item 1. Once a cursor track exists, this is keyframe generation over data
the compositor can already render.

### Camera background removal

Real-time segmentation with MediaPipe or the browser's own
`BackgroundBlur` where available. Expected in this category and currently
absent.

---

## The NLE long tail

Worth having, none of it urgent, roughly in order of how often it is missed:

- **Audio**: normalise, a compressor, a simple EQ. A full mixer with buses is
  not what this audience needs — three good processors are.
- **Curves and colour wheels.** The grade controls today are filter-chain
  approximations; curves need a real per-pixel pipeline, which the WebGL work
  above would also serve.
- **Batch export** — several presets from one timeline, queued.
- **Copy/paste and paste-attributes** on clips.
- **Roll and slide trims**, to finish the professional trimming set.
- **Adjustment layers**, so a grade can sit above several clips.
- **Nested sequences.**
- **Multicam**, which the shared-clock recording model is unusually well set up
  for.
- **LUT support** — cheap once there is a shader pipeline.

## Not doing

Named so nobody spends a weekend discovering why:

- **ProRes, DNxHD and DNxHR encoding.** No browser exposes them.
- **AAF and OMF interchange.** Same.
- **Dolby Vision mastering.**
- **A native plugin SDK.**
- **Motion tracking and stabilisation** are possible in principle but are large,
  specialised projects that would not change who picks this tool up.

---

## Product, not features

Cheap, and they matter more than another effect:

- **An empty state that teaches.** The first run should record a five-second
  take and drop the user into the editor with it.
- **A keyboard shortcut reference** — there are around twenty and none are
  discoverable.
- **Undo history that names what it undid** — the panel exists and the labels
  are there; they are just not surfaced anywhere else.
- **A real name and domain.** See [`NAME.md`](NAME.md); the short options are
  either taken or registry-premium, and the search is unfinished.
