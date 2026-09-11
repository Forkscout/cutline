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

**Done on macOS.** The page cannot see the cursor outside its own window, and
no capture API reports it, but the local server runs on the same machine: it
samples `NSEvent.mouseLocation` and `pressedMouseButtons` at 60 Hz through a
long-running JXA process (no permission prompt, nothing compiled) for the length
of every take with a screen, and writes `recordings/<id>/cursor.jsonl` on the
session clock with paused time cut out. The library marks takes that have one.

Still open:
- **Windows and Linux samplers.** `GetCursorPos`/`GetAsyncKeyState` and
  `XQueryPointer` behind the same `CursorService`; today those platforms record
  without a cursor track and say so.
- **Mapping into the picture for window and tab captures.** A full-screen
  capture maps through the display frames in the header; a window moves, and
  its bounds over time are not recorded yet.
- **The first ~90 ms.** Sampling starts once the socket and the sampler are up,
  so a take's opening moment has no cursor.
- **Using it.** Auto-zoom and cursor smoothing are not built — but every take
  from here on can have them.

### 2. A local server — decided

There is one now: a Hono server on Bun, bound to 127.0.0.1, that owns projects,
recordings and imported media on disk in `~/Cutline`. The browser keeps only
the recorder's capture buffer, and hands each take over when it ends. It sits between the two options this item used to
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

Done: recordings and imported media live on the server, served with byte
ranges, and `/mcp` lets an agent edit the open project through the editor tab.
Next in this direction: an export tool for the agent, alpha-channel overlays
(the gate in the AI checklist's animation section), and a headless mode for
batch work with no tab open.

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

- ~~Long recordings are unmeasured.~~ Measured on a 10-minute 2560×1440 take
  (467 MB, run headless with `bun scripts/headless-check.ts
  dev-stress-check.html?seconds=600`): the heap grew 0.8 MB while recording;
  import took 45.7 s (0.08× realtime — server remux 0.3 s, proxy 44.3 s,
  waveform 1.0 s) and left 12.6 MB held after a collection, against 89 MB of
  peak garbage at one minute and 160 MB at ten; the proxy is 129 MB against
  456 MB; the far end decodes in 181 ms and a `<video>` seeks to it. On the
  server a 2 GB upload streams in 0.58 s without moving its memory, and a
  726 MB remux raises the physical footprint from 59 to 83 MB, back to 62 MB
  once the idle worker ends. Still projected rather than run: a real two-hour
  take, and a real screen instead of a synthetic canvas.
- ~~Import remuxes in the browser's memory.~~ Done: the remux runs on the server
  file to file, on a worker; proxies (which need the browser's encoder) stream
  up in positional pieces; waveforms decode a batch at a time.
- ~~Interrupted takes are invisible.~~ Done: the library finds takes with no
  `meta.json` and no live recording lock, and offers to recover (rebuild the
  metadata by probing the files, after cutting each back to its last complete
  block) or discard them. What recovery cannot rebuild — track offsets and
  pauses — it sets to zero and none.
- **A truncated upload gets no reply.** The server stores nothing — the length
  check holds — but when a client hangs up mid-body the request waits for Bun's
  idle timeout instead of failing at once.

## What would actually make it win

For the people who record their screen to explain something.

### Auto-captions

Done. The highest-leverage AI feature — not because captions matter most on
their own, but because the transcript unlocks the two items below. The server
sends the audio to whichever OpenAI-compatible speech-to-text service the user
connected (whisper.cpp's server locally, or a hosted one with a key), and
right-clicking any clip with sound offers Generate captions.

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
