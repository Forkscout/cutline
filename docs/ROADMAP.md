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

### 2. Decide whether there will ever be a server

Right now nothing leaves the machine, and the README says so. That is a real
promise and part of the appeal.

Sharing, comments, collaboration and cloud rendering all require breaking it.
That is not a task, it is a different product, and the answer changes what is
worth building in the meantime. Loom's entire business is the share link.

Deciding "no" is a perfectly good answer — it just needs to be a decision
rather than a drift.

---

## Correctness and risk

Things that are wrong or fragile now. None of these are features; all of them
will bite someone.

### Export blocks the main thread

`exportProject` runs the composite-and-encode loop inline. A long export
freezes the interface completely — no progress feels live, no cancel feels
responsive, and the tab may be killed as unresponsive.

Move it to a worker with `OffscreenCanvas`. The compositor already takes a
context rather than reaching for the DOM, so it should mostly transfer;
`textMetrics` and the scratch-canvas pool are the parts that need adapting.

### There is no error boundary

One throw anywhere in the render path white-screens the app, and the user loses
whatever was not autosaved. An editor is exactly the wrong place for that.

Wrap the editor in an error boundary that keeps the project in memory and
offers to save it.

### No proxy workflow

A 4K screen recording will stutter in the preview, because the preview decodes
the full-resolution file in real time. Every editor solves this the same way:
generate a small proxy on import and play that, then conform to the original at
export.

The import path already remuxes and probes, so the hook exists. This is the
difference between "works on my test fixture" and "works on real footage".

### Chroma key runs a per-pixel pass in JavaScript

`applyChromaKey` calls `getImageData`, walks every pixel, and calls
`putImageData` — per frame, per clip. That is roughly 10–20 ms at 1080p, which
is tolerable while paused and ruins playback.

It wants a WebGL or WebGPU shader. Same for `posterize`, which has the same
shape.

### Long recordings are untested at scale

Files are handed to `<video>` as blob URLs. A two-hour screen capture is
several gigabytes, and nothing in this codebase has been run against one.
Seek behaviour, memory, and OPFS quota all need measuring before anyone is told
it works.

### Autosave has no conflict handling

Two tabs open on the same project will silently overwrite each other. A
`BroadcastChannel` lock, or a last-write-wins warning, would be enough.

### The timeline is not keyboard navigable

Clips can only be selected and moved with a pointer. That is both an
accessibility failure and a speed ceiling for anyone who edits daily.

---

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
