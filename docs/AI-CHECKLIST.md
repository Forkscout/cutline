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

## 0. The decision that gates everything

- [ ] **Choose where inference runs**
  **Problem** — Every item below needs a model, and the answer changes all of
  them. Today nothing leaves the machine and the README says so.
  **Approach** — Three options, and they can coexist: models in the browser
  (transformers.js / ONNX Runtime Web, WebGPU where available), a local runtime
  the user already has (Ollama, LM Studio, an MLX server on localhost), or the
  user's own API key held in local storage. In-browser keeps the privacy promise
  and costs a download of 40–900 MB depending on the model; a key is instant and
  breaks the promise unless it is clearly labelled.
  **Test** — Not a test, a written decision in `CLAUDE.md`. Do this before
  building item 1, because item 1 hardcodes the answer.

- [ ] **A model cache and a first-run download experience**
  **Problem** — A 200 MB model download that starts silently on the first
  caption request feels broken.
  **Approach** — Cache in the Origin Private File System next to the
  recordings. Show size, progress, and an explicit "download once" step.
  **Test** — Second run loads from cache with the network offline.

---

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
