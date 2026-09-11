# AI checklist

Nothing here is built yet. The list is ordered so each item can be taken alone,
shipped, and tested before the next one starts — several of them depend on the
transcript, so that comes first and the rest fan out from it.

Every item names the problem it solves, because "add AI to the editor" is not a
problem and the features that come out of that framing are the ones nobody uses.

Format: **Problem** is what the user suffers today. **Approach** is the shortest
path that could work. **Test** is what proves it, in the style of the harnesses
already in this repo — a measurement, not a look.

---

## 0. How inference reaches the app

Different tasks genuinely need different providers — Ollama cannot transcribe,
only some endpoints generate images, local Whisper is free and private but
slower than a cloud call. So the routing has to be per capability.

**The user must never see that.** A settings page with five endpoints to fill in
before auto-captions works is where this feature dies. The resolution is that
configuration is *discovered*, not declared: the user adds a provider, the app
works out what it can do, and every capability routes itself.

### The model

- [ ] **Capabilities, providers, and automatic routing between them**
  **Problem** — Per-task configuration is correct and unusable. One global
  endpoint is usable and wrong.
  **Approach** — Name the capabilities the app can want — `transcribe`, `text`,
  `vision`, `image`, `video`, `speech`, `embed`. A provider is only a name, a
  base URL and an optional key. Routing resolves each capability on its own, in
  a fixed order: **in-browser first, then a local server, then cloud** — cheapest
  and most private wins by default. An Advanced panel can pin a capability to a
  specific provider and model, and nobody should ever have to open it.
  **Test** — With two providers registered where only one transcribes, assert
  the transcribe capability resolves to that one and text resolves to the higher
  priority one.

- [ ] **Adding a provider reports capabilities, not success**
  **Problem** — "Connection successful" is what lets someone point the app at
  Ollama, see a green tick, and discover only at the captions button that the
  entire transcript half of this list is unavailable.
  **Approach** — On add, probe `/v1/models` and the optional endpoints, then
  show what came back as a capability list: *text ✓ · vision ✓ · transcription
  ✗*. Say what is missing and what would provide it.
  **Test** — Point it at an endpoint with no audio support; assert the report
  marks transcription unavailable and the captions feature stays hidden rather
  than failing on use.

- [ ] **Ask in context, never up front**
  **Problem** — A setup wizard before the first recording is a wall in front of
  a product whose whole point is that you press record.
  **Approach** — No AI configuration exists until something needs it. The first
  time a feature wants a missing capability, ask at that moment, in that panel,
  with the cheapest option already selected — "Auto-captions needs speech to
  text: **download the model once (142 MB), runs on this machine** · or connect
  a provider".
  **Test** — A fresh profile can record, edit and export end to end without
  encountering a single AI setting.

- [ ] **Features degrade, they do not error**
  **Problem** — A panel full of controls that throw when pressed is worse than
  a panel that is honest about not being ready.
  **Approach** — Every AI-backed control checks its capability first. Missing
  means the control is replaced by the one-line offer above, not disabled with a
  tooltip and not present-but-broken.
  **Test** — With no providers and no downloaded models, assert no AI control in
  the interface can produce an error dialog.

- [ ] **Say where it will run, before it runs**
  **Problem** — The README promises nothing leaves the machine. The moment a
  cloud key exists, that promise needs to be visible per action rather than
  taken on trust.
  **Approach** — A small chip on every AI action naming the destination — *on
  this machine* or *OpenAI* — decided by whether the resolved base URL is local.
  **Test** — Assert the chip matches the resolved route for each capability, and
  that a local route issues no external request.

### What routes where, by default

| capability | default | why |
|---|---|---|
| `transcribe` | in-browser Whisper | The foundation of section 2, and the case that must be zero-config. Free, private, one download. This machine already has `whisper-large-v3-turbo` cached. |
| per-frame vision and audio | in-browser, never configurable | Segmentation, face tracking and denoise run every frame. Thirty HTTP round-trips a second is not a design, wherever the endpoint lives. |
| `text`, `vision` | whatever provider exists | Chapters, titles, translation, retake grouping, natural-language edits. Genuine niceties — the editor works without them, so absence should hide the feature, not block the app. |
| `image`, `video` | cloud, realistically | Generated b-roll and backgrounds. Nothing local generates these at usable quality yet; keep the capability defined so that changes without a rewrite. |
| `speech` | either | Text-to-speech for narration replacement. Low priority. |

### One client underneath

Everything above rides on a single OpenAI-compatible client with a configurable
base URL — `https://api.openai.com/v1`, `http://localhost:11434/v1` for Ollama,
`http://localhost:1234/v1` for LM Studio, and equally Groq, OpenRouter,
llama.cpp's server or vLLM. Capability detection is what turns that one client
into per-task routing, without the user filling in a form per task.

### Gotchas worth knowing before the first request

- [ ] **CORS on local servers**
  **Problem** — A page on `localhost:5310` calling `localhost:11434` is a
  cross-origin request, and local runtimes reject it by default. The failure is
  an opaque network error that looks like the server is down.
  **Approach** — Ollama needs `OLLAMA_ORIGINS` set to include the app's origin;
  LM Studio has a CORS switch in its server settings. Detect this case and name
  the setting — do not report "could not connect".
  **Test** — Assert the message for a CORS failure differs from the one for a
  genuinely unreachable server.

- [ ] **Be honest about where the key goes**
  **Problem** — There is no backend here, so a cloud key sits in the browser
  and travels with every request from the page. That is the user's call to
  make, but only if they are told.
  **Approach** — Say it plainly next to the field, and let the default routing
  above mean most people never add one.
  **Test** — Assert nothing leaves the machine when every capability resolves
  locally, by watching the network panel with a cloud key present but unused.

> Endpoint behaviour above is from documentation, not from a running server —
> nothing here was verified against a live Ollama or LM Studio instance. Confirm
> `/v1/models` and `/v1/audio/transcriptions` on whichever you target before
> building on them.

## 1. Transcript — the foundation

Almost everything else is a view over this.

- [ ] **Auto-captions**
  **Problem** — Captions are effectively mandatory now and writing them by hand
  is the slowest part of publishing.
  **Approach** — Whisper (`whisper-base` for speed, `large-v3-turbo` where
  WebGPU exists) over the microphone track, which is already a separate file.
  Word-level timestamps, not just segments — everything below needs them.
  **Test** — Transcribe a fixture with a known script; assert word error rate
  under a threshold and that every word's timestamp falls inside the clip.

- [ ] **Word-level alignment to the timeline**
  **Problem** — A transcript that is not frame-accurate cannot drive edits.
  **Approach** — Store words with start/end against the same clock as the
  clips, so a cut derived from a word is exact.
  **Test** — Cut on a word boundary, export, and confirm the audio at the cut
  point matches the expected sample offset.

- [ ] **Speaker separation**
  **Problem** — Two people on one microphone track cannot be edited apart.
  **Approach** — Diarisation (pyannote-style, or a small ONNX model). Cutline's
  multi-source recording means this often is not needed — separate mics are
  already separate files — so scope it to imported footage.
  **Test** — A two-voice fixture; assert the segment boundaries land within a
  tolerance of the known switches.

- [ ] **Library-wide transcript search**
  **Problem** — "I explained this once, in one of forty recordings."
  **Approach** — Index transcripts as they are generated; search returns a
  recording and a timestamp.
  **Test** — Search a phrase that exists in exactly one take; assert one result
  at the right second.

---

## 2. Editing driven by the transcript

- [ ] **Text-based editing**
  **Problem** — Cutting speech on a waveform is slow and imprecise. Reading is
  faster than scrubbing.
  **Approach** — Render the transcript as a document; deleting a sentence
  deletes the matching range from every linked clip. The linking model already
  guarantees the picture and the voice stay together.
  **Test** — Delete a known sentence, export, and assert the exported duration
  dropped by exactly that sentence's length and the words either side survive.

- [ ] **Filler-word removal**
  **Problem** — "Um", "uh", "like", "you know" — dozens per take, tedious to
  cut, and the single most visible difference between a rough and a finished
  recording.
  **Approach** — Find them in the transcript, propose the cuts as a reviewable
  batch, never apply silently. Short crossfades so the joins do not click.
  **Test** — A fixture with a counted number of fillers; assert all are found,
  nothing else is proposed, and the audio at each join has no discontinuity
  above a threshold.

- [ ] **Silence and dead-air tightening**
  **Problem** — Long pauses make a recording feel slow, and finding them by ear
  costs a full viewing.
  **Approach** — Audio peaks are already computed at import, so detection is
  nearly free. Propose cuts with an adjustable minimum pause and a keep-margin.
  **Test** — Insert known silences into a fixture; assert each is found and
  that shortening them changes the export duration by the expected amount.

- [ ] **Retake detection**
  **Problem** — This is the one that matters most for a recorder. You flub a
  line, stop, say it again. Finding every retake and keeping the good one is
  most of the work in a talking-head edit.
  **Approach** — Look for near-repeated text spans in the transcript, cluster
  them, and offer the takes side by side with the last one selected by default.
  **Test** — A fixture that says the same sentence three times with a stumble in
  the first two; assert all three are grouped and the third is chosen.

- [ ] **Chapters and titles**
  **Problem** — Long recordings need chapter markers, and writing a title and
  description is a separate chore after the edit is done.
  **Approach** — Segment the transcript by topic; emit timeline markers, a
  title, a description, and a YouTube-format chapter list.
  **Test** — A fixture with three clearly distinct topics; assert three markers
  within a tolerance of the known boundaries.

- [ ] **Caption translation**
  **Problem** — Reaching an audience that does not speak the recording's
  language means paying for subtitles.
  **Approach** — Translate the existing cues; keep timings, re-wrap lines to
  the caption width.
  **Test** — Round-trip a known phrase and assert cue count and timings are
  unchanged.

---

## 3. At capture time

Things that are better fixed while recording than repaired afterwards.

- [ ] **Voice isolation and denoise**
  **Problem** — Fans, keyboards, traffic, room echo. Unfixable later without a
  model, and it is the difference between amateur and not.
  **Approach** — A small real-time model on the microphone track. Record the
  clean and the raw version, or record raw and process on import — the second
  is safer, because a bad denoise is unrecoverable.
  **Test** — Mix a known noise bed into a clean fixture; assert the processed
  signal-to-noise ratio improves and the speech band is not gutted.

- [ ] **Camera background removal and blur**
  **Problem** — Expected in this category, and currently absent.
  **Approach** — MediaPipe selfie segmentation, or the browser's own
  `BackgroundBlur` where the platform offers it. Composite in the existing
  layer pipeline so it exports identically.
  **Test** — A green-screen fixture keyed both ways; assert the two mattes agree
  within a tolerance, and that the effect reaches the exported pixels.

- [ ] **Auto-framing the camera**
  **Problem** — People drift out of frame, and a fixed picture-in-picture crop
  is a compromise made before the take.
  **Approach** — Face detection driving the existing `transform.x/y/scale` as
  keyframes, smoothed hard so it never feels like a security camera.
  **Test** — A fixture where the subject moves across frame; assert the
  generated keyframes keep the face inside the middle third, and that
  frame-to-frame movement stays under a jerk threshold.

- [ ] **Eye-contact correction**
  **Problem** — Reading notes means never looking at the lens.
  **Approach** — A gaze-redirection model on the camera track. Genuinely hard,
  genuinely uncanny when it goes wrong, and worth attempting only after the
  rest.
  **Test** — Human review, honestly. This is one where a metric would lie.

---

## 4. What only a screen recorder can do

The strongest differentiators are here, because they use data no general editor
has.

- [ ] **Auto-blur sensitive data on screen**
  **Problem** — Screen recordings leak API keys, tokens, email addresses,
  customer names and account numbers constantly, and the leak is discovered
  after publishing or never. Nothing else on this list prevents an actual
  incident.
  **Approach** — OCR each frame (or each keyframe), match against patterns for
  keys, tokens, emails, card and account numbers, then track the boxes across
  frames and blur them as a masked layer. Default to flagging for review rather
  than blurring silently — a false negative is a breach, a false positive that
  the user never saw is also a breach.
  **Test** — A fixture screen recording containing a planted key, an email and
  a card number; assert each is found, that the blurred region covers it in
  every frame it appears, and that the exported file no longer OCRs to the
  secret.

- [ ] **Auto-zoom from cursor and click data**
  **Problem** — A full-desktop recording of a small UI interaction is
  unwatchable, and zooming by hand means keyframing every step.
  **Approach** — Requires the cursor track from `ROADMAP.md`, which must be
  captured at record time. The model's job is not the zoom — that is
  keyframes the compositor already renders — but deciding *when* a zoom helps
  and when it is nausea.
  **Test** — A fixture with known click positions; assert a zoom is generated
  for each cluster, that none is shorter than a minimum dwell, and that
  consecutive zooms never overlap.

- [ ] **Screen content search and callouts**
  **Problem** — "Where in this demo did I open the settings page?"
  **Approach** — OCR the screen track into a time-indexed text layer. Doubles
  as a source for automatic callout labels and chapter names.
  **Test** — A fixture where a known string appears for a known window; assert
  the search returns that window and not the frames either side.

- [ ] **Skip the waiting**
  **Problem** — Demos are full of loading spinners, builds and page loads. The
  viewer does not need to wait with you.
  **Approach** — Detect stretches where the screen barely changes and nothing
  is being said, and propose a speed ramp rather than a cut, so the demo still
  reads as continuous.
  **Test** — A fixture with a planted 8-second static stretch; assert it is
  found and that the ramp preserves the surrounding audio pitch.

---

## 5. Assembly

- [ ] **Rough cut from a script**
  **Problem** — When there is a script, matching the takes to it by hand is
  mechanical work.
  **Approach** — Align the transcript to the script, pick the best take per
  line, assemble the timeline.
  **Test** — A fixture with three takes of a four-line script; assert the
  assembly has four clips in script order.

- [ ] **Highlight extraction**
  **Problem** — A twenty-minute recording contains one minute worth posting,
  and finding it costs a viewing.
  **Approach** — Score transcript segments, propose 30–60 second cuts, hand
  them to the existing vertical presets.
  **Test** — A fixture with one deliberately distinctive passage; assert it
  ranks first.

- [ ] **Smart vertical reframe**
  **Problem** — Every 16:9 recording needs a 9:16 version, and a centre crop
  throws away whatever mattered.
  **Approach** — Track the subject — face on camera, cursor and active region
  on screen — and generate position keyframes rather than a static crop.
  **Test** — Assert the tracked subject stays inside the vertical safe area for
  a set fraction of frames, and that the crop path has no jump above a
  threshold.

---

## 6. The reviewer

This one closes a loop the repository opened. An earlier project under this name
existed to give an agent eyes on its own video output, on the grounds that **an
editor that cannot see its own output ships broken frames**. It was never built.
The export pipeline here can already decode its own output and read pixels — the
test harness does exactly that — so the machinery exists.

- [ ] **A quality check over the finished export**
  **Problem** — The failures that actually ship are the ones no dialog warns
  about: a silent stretch where there should be narration, text too small to
  read on a phone, a frozen section, clipped audio, a caption running off the
  frame, a face cropped by the picture-in-picture.
  **Approach** — Decode the exported file, sample frames and audio, and report
  findings with timestamps the user can click. Most of it needs no model at all
  — silence against the transcript, frame-difference for freezes, contrast
  ratios, peak detection. A model helps only for "is this readable" and "is this
  framed well".
  **Test** — Build fixtures that each contain exactly one planted defect;
  assert each is found, at the right timestamp, and that a clean export produces
  no findings. That last half is the one that matters — a checker that always
  finds something is noise.

- [ ] **Natural-language edits**
  **Problem** — "Tighten the first minute", "make the camera bigger after the
  intro", "cut everything before the demo" are all faster to say than to do.
  **Approach** — Map instructions onto the existing reducer actions, which are
  already a closed, serialisable set. Show the diff before applying; the undo
  stack makes it safe.
  **Test** — A set of instructions with known expected action sequences; assert
  the produced actions match, and that every one of them is reversible with a
  single undo.

---

## 7. An agent that edits the whole video

Section 0 is Cutline calling models. This section is the inverse: a model — in
Claude Code, Claude Desktop, or any MCP client — calling Cutline. Both can
exist; this one needs no model of Cutline's own, because the agent brings it.

It is more reachable here than in most editors because of a decision already
made: **the project is plain JSON and every edit is a serialisable reducer
action.** An agent does not need to operate the interface. It sends the same
actions the interface sends, they land in the same undo stack, and the user can
walk any of them back.

### The bridge

- [ ] **An MCP endpoint that reaches into the open tab**
  **Problem** — Projects, recordings and media are on disk now, behind the local
  server, so an agent can read them. But the project being edited lives in the
  tab's memory until it autosaves, and a page cannot listen on a port — edits
  written to disk behind the tab's back would be overwritten by its next save.
  **Approach** — `/mcp` on the existing server, speaking MCP over streamable
  HTTP to the agent and a WebSocket to the tab. The tab stays the source of truth, which
  also means the user watches the agent's edits land live and can stop it. A
  headless mode — the bridge driving its own browser — is a later addition for
  batch work, not the first build.
  **Test** — Start the bridge, open a project, call `get_project` from an MCP
  client; assert the JSON matches what the tab holds, byte for byte.

- [ ] **Tools generated from the reducer, not written beside it**
  **Problem** — A hand-written tool list drifts from the reducer the first time
  an action is added, and the agent then either cannot do something the UI can
  or does it with the wrong shape.
  **Approach** — One schema per `Action` variant, from which both the MCP tool
  definitions and runtime validation are generated. Typed, described tools per
  action rather than one generic `apply` — models choose far better from
  specific tools with specific descriptions.
  **Test** — Assert every variant of `Action` has a tool, and that a malformed
  call is rejected with the validation error rather than reaching the reducer.

### Eyes — the tools that matter most

An agent that cannot see its output ships broken frames. That sentence is where
the earliest version of this repository started; the compositor can now draw any
frame on demand, so this is finally cheap.

- [ ] **`render_frame(time)` returns an image**
  **Problem** — Without it the agent edits blind and reports success from the
  JSON, which is exactly how a frozen scene or a cropped face gets called done.
  **Approach** — Run `drawFrame` at the requested time into an offscreen canvas
  at a modest resolution and return it as an image. Add a contact-sheet variant
  that samples a range, because one frame at one guessed time proves almost
  nothing.
  **Test** — Request a frame at a time where a known layer is visible; assert
  the returned image contains that layer's colour at its placed position.

- [ ] **Hearing and reading, alongside seeing**
  **Problem** — Half the defects that ship are audio: a silent stretch, a
  clipped peak. No image shows them.
  **Approach** — `audio_envelope(range)` from the peaks already computed at
  import, and `transcript(range)` once section 1 exists.
  **Test** — Plant a silence; assert the envelope reports it at the right time.

- [ ] **The agent verifies before it reports**
  **Problem** — The failure this whole section exists to prevent is an agent
  saying "done" after one look.
  **Approach** — The server's instructions require sampling the touched range
  and running the section 6 quality check before a task is reported complete.
  Put it in the tool descriptions, not only in a prompt the client may drop.
  **Test** — Give the agent a task with a planted defect in the touched range;
  assert it reports the defect rather than success.

### Animations

- [ ] **Native layers first**
  **Problem** — Rendering a lower third through a separate framework produces
  a baked video nobody can re-time or retype.
  **Approach** — Titles, lower thirds, callouts and simple motion use the text
  and shape layers, keyframes and transitions that already exist. They export
  through `drawFrame`, stay editable by the user afterwards, and cost nothing
  to render. The agent should reach past them only when they genuinely cannot
  do the job.
  **Test** — Ask for a lower third; assert it arrives as text and shape clips
  with keyframes, not as an imported video.

- [ ] **Remotion or HyperFrames for what native layers cannot do**
  **Problem** — Charts, data visualisation, code walkthroughs and dense motion
  graphics are beyond a layer-and-keyframe system, and are exactly what a
  code-writing agent is good at.
  **Approach** — The agent writes a composition; the bridge renders it — both
  frameworks render through headless Chrome, which belongs in the Node process,
  not the tab — to a video file **with an alpha channel**; the result is
  imported as an ordinary asset and placed on a track as an overlay. From that
  point it is just a clip.
  **Test** — Render a composition with a transparent background over a solid
  colour clip; export; assert the solid colour shows through where the
  animation is empty.

- [ ] **Verify alpha survives the whole path — before building the above**
  **Problem** — `<video>` plays transparent VP9 WebM in Chrome, but the export
  path decodes through WebCodecs, and alpha support there is much less certain.
  An overlay that is transparent in the preview and black in the export is the
  worst possible outcome, because it looks fine until delivery.
  **Approach** — Test import, remux, preview and export with a transparent file
  first. If WebCodecs drops alpha, fall back to a PNG sequence or a separate
  matte clip, and decide that before the animation tool is written.
  **Test** — The test above, run on its own, is the gate for this section.

- [ ] **Keep the source next to the render**
  **Problem** — A rendered animation is a dead end: changing one word means
  asking the agent to regenerate the whole thing from memory.
  **Approach** — Store the composition source with the asset, so the agent or
  the user can edit it and re-render in place.
  **Test** — Change a string in a stored composition, re-render, and assert the
  clip on the timeline updated without moving.

### Control, and its limits

- [ ] **Full control of the project, not of the machine**
  **Problem** — "Full control" is a phrase that is fine for a timeline and not
  fine for a user's recordings.
  **Approach** — Tools are scoped to the open project. No tool deletes
  recordings or projects. Export writes a new file and never overwrites one.
  **Test** — Assert the tool list contains nothing that can remove a file
  outside the project's own scratch space.

- [ ] **One undo step per agent turn, named**
  **Problem** — Forty reducer actions in forty history entries makes "undo what
  the agent just did" forty key presses.
  **Approach** — Coalesce each agent turn into one history entry, labelled with
  the instruction: *Agent: tighten the intro*. The history panel already exists.
  **Test** — Run a multi-action agent turn; assert a single undo restores the
  prior state exactly.

- [ ] **Sandbox the code the agent writes**
  **Problem** — Rendering a Remotion or HyperFrames composition is running
  code an agent wrote, on the user's machine.
  **Approach** — Render in a separate process with a time limit, no network
  access, and writes confined to a scratch directory. Fail closed.
  **Test** — Submit a composition that tries to read outside its directory and
  one that tries to fetch a URL; assert both are refused.

> Framework details in this section — HyperFrames especially — are from memory,
> not from checking the current packages. Confirm how each one renders and
> whether it can emit alpha before designing the bridge around it.
