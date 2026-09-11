# Cutline

A browser-based video editor with recording built in. You capture screen, camera
and microphone in one take — as separate files on a shared clock — then edit
them on a timeline and export without leaving the browser.

> An earlier, unrelated project lived in this repo under the same name: tooling
> to let an agent verify its own edits to a Remotion composition. It was never
> built, and its notes were kept out of the public history because they
> described a client's unreleased video in detail.
>
> One idea from it is worth carrying forward: **an editor that cannot see its own
> output ships broken frames.** That is why the export path here is verified by
> decoding the file back and reading its pixels, rather than by looking at the
> preview and assuming.

---

## Status

Record, edit and export work end to end, full-page. The editor covers roughly
the first two-thirds of a conventional NLE feature set; the honest gaps are
listed at the bottom of this file.

| area | state |
|---|---|
| Multi-source recorder | done |
| Projects: save, autosave, recovery, duplicate, delete | done |
| Media pool: import, thumbnails, waveforms, bins, search | done |
| Timeline: n tracks, trim/ripple/slip, snapping, markers | done |
| On-canvas select, drag, resize and rotate | done |
| Linked A/V clips, detach audio | done |
| Export in a worker, proxies, GPU chroma key | done |
| Compositing: transform, blend, mask, chroma key, effects, grade | done |
| Keyframes and transitions | done |
| Text and shape layers | done |
| Captions: manual, SRT/VTT in and out, burn-in | done |
| Scopes: histogram, waveform, parade, vectorscope | done |
| Export: MP4/WebM, presets, bitrate, in/out range | done |
| Auto-captions (Whisper) | not started |

## Decisions already made

These were chosen deliberately. Reopen them only with a reason.

- **Export is client-side, via WebCodecs.** Not ffmpeg.wasm (roughly ten times
  slower, and it hits the browser's memory ceiling on anything long), not a
  render server. Nothing leaves the machine.
- **Auto-captions are the first AI feature.** The transcript is also the
  foundation for text-based editing and silence detection later, so it is worth
  building first even on its own merits.
- **Every source is its own file.** Never a pre-mixed one. Mixing at record time
  is a decision that cannot be taken back, and the whole point is that the edit
  gets to decide.
- **mediabunny does the demuxing, decoding and muxing.** It replaced the
  hand-rolled seeking workarounds outright: frame-accurate decode at a
  timestamp, a copy-remux that fixes the recorder's index-less WebM, and an
  encoder path that feeds WebCodecs.
- **Preview and export share one `drawFrame`.** See below; this is the single
  most important invariant in the codebase.

## Running it

```bash
bun install
bun run dev      # web app on :5310, local server on :5311
```

Ports 3900/3901 belong to an unrelated app on this machine (OmniVoice Studio),
which is why the dev server sits on 5310.

`bun run typecheck` before committing. The `tsconfig` is strict, including
`noUncheckedIndexedAccess`. `exactOptionalPropertyTypes` was dropped when
shadcn arrived: its generated components spread Radix props typed without
`| undefined`, and patching them would mean re-patching after every `add`. The
recorder still spreads optional fields conditionally rather than assigning
`undefined`, by convention rather than by compiler.

## UI stack

Tailwind v4 (via `@tailwindcss/vite`, no config file — the theme lives in
`@theme inline` in `src/index.css`) and **shadcn/ui**. `@/` resolves to `src/`.

Plus Jakarta Sans for interface, JetBrains Mono for timecode and byte counts.
The palette is a lime accent (`--primary`) on green-biased neutrals, with a
deep forest green (`--surface-deep`) behind anything that stands in for a
captured picture.

**The app runs two schemes on purpose.** Capture and library are light — you are
choosing and arranging there, and it should feel like paper. The editor stamps
`data-theme="dark"` on the *document element* for as long as it is mounted,
because a bright surround shifts how you read exposure and colour. The stamp is
global rather than scoped to the editor's own root because Radix renders
dialogs, menus and popovers into `document.body`; a scoped stamp would leave
every one of them light on a dark app. It restores the previous value on
unmount, so the header's toggle keeps working.

**Light is the default regardless of `prefers-color-scheme`.** That is the
design, not an oversight — respecting the OS would give both halves the same
appearance and lose the distinction above. `useTheme` persists the viewer's
own choice.

```
src/components/ui/    shadcn primitives — regenerable, avoid hand-editing
src/components/       app components
src/hooks/  src/lib/  hooks and helpers
src/recorder/         no React in here, and it should stay that way
```

Add a component with `npx shadcn@latest add <name> --yes`. **Check its imports
afterwards.** The CLI wrote `import { cn } from "cn"` into all fourteen of the
first batch and installed a real, unrelated npm package by that name to satisfy
it; the correct import is `@/lib/utils`.

The stray-import problem recurs on *every* `add` — it happened again on the
second batch. Check, fix, and `bun remove cn`.

Overriding a shadcn variant with a `className` does not reliably work — Radix's
`Slot` concatenates the two class strings rather than running them through
`tailwind-merge`, so which one wins is down to stylesheet order. Pass the
component's own `variant` prop instead. `AlertDialogAction` accepts one.

The app is dark-only: `<html class="dark">` is fixed in `index.html`, and
`sonner.tsx` was edited to drop its `next-themes` dependency.

## Verifying a change

Two harnesses, both permission-free — a canvas stream and an oscillator are
indistinguishable from a camera and a microphone as far as MediaRecorder is
concerned.

**`/dev-check.html`** covers the recorder: chunk ordering, the OPFS worker,
offsets, pause accounting, reading files back. Add `?keep` to leave the take on
disk so the library and the editor have something real to open.

**`/dev-editor-check.html`** covers everything after that — the edit reducer,
keyframe interpolation, subtitle round-tripping, the take's move to the server, import and remux, project
layout, export — and then **decodes the exported file and reads its pixels**,
checking the background in the padding, the screen layer in the middle, the
camera where the PiP was placed, that text and captions were drawn, and that an
effect and a colour grade actually reached the file.

That last part is not belt-and-braces. The first export this project produced
was the right duration, the right codec and the right resolution, and entirely
blank: `sourceSize` read `width`/`height` off a `VideoFrame`, which has neither,
so the layout maths went to NaN and `drawImage` became a silent no-op. Nothing
short of looking at the pixels would have caught it.

**Never probe text with a single pixel.** A glyph is mostly empty space, and the
centre of a centred string lands between strokes as often as not. Scan a band
and count bright pixels — two assertions here failed for exactly that reason
while the renderer was correct.

**Front the browser tab before trusting a result.** A hidden tab suspends
`requestAnimationFrame` and clamps `setTimeout` to one second.

## The local server

`server/` is a Hono app on Bun that owns everything on disk under
`~/Cutline/workspaces/<workspace>/`: `projects/<id>.json`,
`recordings/<sessionId>/` and `media/<assetId>`. In development Vite serves the
page on 5310 and proxies `/api` to the server on 5311; `bun run start` serves
both from one process.

**OPFS is only the capture buffer.** The recorder still writes to OPFS, because
a take must survive the tab dying and must not depend on a process on the other
end of a socket. When a take stops, `src/lib/sync.ts` moves it: every media file
first, `meta.json` last (the server lists a take only once its meta exists),
then each size is read back, and only when all of them match is the browser's
copy deleted. A session with no `meta.json` is never touched — that is a take
still recording, or a crashed one whose chunks are the only copy. The sync is
single-flight within a tab and serialised across tabs with a Web Lock. The same
path migrates takes and imports left in OPFS by older versions.

**Media is read by URL, with byte ranges.** `<video src>`, mediabunny's
`UrlSource` in import and in the export worker — nothing pulls a whole recording
into memory to play or export it. None of those can send the token header, so
`main.tsx` awaits `startSession()` before rendering: `POST /api/session` trades
the token for an `HttpOnly; SameSite=Strict` cookie scoped to `/api`, and the
guard accepts either. Sizes come from the `x-file-size` header, never
`content-length`, which on a HEAD or a 206 is not the file's size.

**Uploads are streamed and length-checked.** `DiskMediaStore.write` reads the
body with `getReader()` into a `FileSink`, counts what reached the file, and
refuses anything short of the declared length. Do not "simplify" it:
`Bun.write(path, new Response(req.body))` never finishes reading a request body
in Bun 1.3, and `for await` over one intermittently throws "undefined is not a
function". Both were found the hard way.

**Import still builds files in the browser's memory.** The remux and the proxy
are produced into an `ArrayBuffer` and uploaded whole — Chrome only streams
request bodies over HTTP/2, and the dev proxy speaks HTTP/1.1. Fine for minutes
of footage, expensive for hours. Moving remux to the server, file to file, is
the fix.

**Bun is for the server, not for speed.** The heavy work — capture, decode,
composite, encode — happens in the browser and never touches it. Bun earns its
place by running TypeScript directly, having WebSockets built in, and being
Hono's home runtime. Vite still runs under Node.

**It is attack surface even on localhost.** Any open website can send requests
to `127.0.0.1:5311`, and DNS rebinding can make them look same-origin. The
server can write files, and will run render code later, so every `/api`
request needs all three: a Host naming this machine, the app's Origin when one
is sent, and the per-run token. The token is generated by `scripts/dev.ts`,
written into the page by a dev-only Vite plugin (the server injects its own in
production), and never served anywhere a foreign page can read it. The page
itself is Host-checked too, because it is how the token is delivered.

**Ids never reach a path unchecked.** `assertSafeId` refuses anything that is not
a plain id before it is joined into a filename, and `assertSafeName` does the
same for file names inside a take (no separators, no leading dot, no `..`); `..%2F..%2Fescape` is a 400,
not a write outside the workspace.

**Writes are atomic.** Write beside, then rename — a crash mid-save leaves the
old project or the new one, never half of one. The server also refuses a body
whose project id differs from the URL, so one project cannot be saved under
another's name.

**Written so it can be hosted later without a rewrite.** Storage is behind
`ProjectStore` and `DiskMediaStore`; the workspace id is in every path although there is only ever
"local"; nothing about a project is held in server memory; and the three checks
in `security.ts` are the one seam where real authentication would go. Keep all
four true.

## The agent (MCP)

`/mcp` on the same server makes Cutline an MCP server over streamable HTTP. The
server prints the line that registers it:

```
claude mcp add --transport http cutline http://127.0.0.1:5311/mcp --header "Authorization: Bearer $(cat ~/Cutline/mcp-token)"
```

**The tab is the source of truth.** The server never edits a project. It relays
each tool call over a WebSocket (`/api/bridge`) to the editor tab the user
touched last, which turns it into the same reducer action the interface would
dispatch. An edit written to disk behind the tab's back would be overwritten by
its next autosave; relaying also means the user watches every edit land, with a
badge naming the tool. Only the tab holding the project lock takes agent edits.

**Tools are generated from the reducer.** `src/editor/agent-tools.ts` has one
tool per `Action` variant, keyed by the action type, with zod schemas from
`agent-schemas.ts`. `agent-bridge.ts` fails the typecheck if an action has no
tool, or a tool builds the wrong shape of action — add an action and the
compiler asks for its tool. Arguments are validated on the server and again in
the tab.

**Eyes.** `render_frame` and `contact_sheet` decode frames from the originals at
exact times and draw them through `drawFrame`: what the export will contain,
not whatever a preview `<video>` had decoded. `audio_envelope` reads the peaks
computed at import. The server's instructions and the tool descriptions both
tell the agent to look before it reports.

**One undo step per turn.** `start_turn(instruction)` names a history entry
"Agent: …", and every edit until the next turn coalesces into it — but only
while the agent's last entry is still the present one, so a user edit in
between stays its own step. Every history write in `editor.tsx` goes through
`update()`, a ref that React state mirrors, so the bridge reads the latest
history synchronously rather than one render stale.

**Scoped to the open project.** Nothing deletes recordings or projects;
`remove_asset` drops an item from the project and keeps the file.

**Stateless, with its own token.** A fresh MCP server per request, so a restart
under `bun --watch` strands no client session. The bearer token lives in
`~/Cutline/mcp-token` (0600), because the per-run page token changes on every
start. A request carrying a browser Origin is refused.

**Checking it.** `bun scripts/mcp-check.ts setup` creates a test project and
prints a `?project=` link. Open it, then `bun scripts/mcp-check.ts run <id>`
drives it as a real MCP client. It checks that every action has a tool, and
that bad auth and malformed calls are refused. It checks that the rendered PNG
has the layer where it was placed, and that one undo reverts a whole turn
exactly. It checks that a planted two-second gap shows in the envelope, and
that the tab's JSON equals what autosave writes, byte for byte.
`cleanup <id>` removes the project.

## How the editor fits together

```
types.ts        the document — plain JSON, no class instances anywhere
project.ts      the reducer, selectors, and undo as whole snapshots
keyframes.ts    dot-path property animation, clip-relative
effects.ts      effect specs, and grade/effects -> CSS filter chains
compositor.ts   drawFrame(ctx, project, time, resolve)  <- shared
playback.ts     preview: a clock, one element per clip, composite per rAF
export.ts       export: mediabunny decodes, drawFrame draws, WebCodecs encodes
persistence.ts  projects via the server; crash recovery in localStorage
media.ts        import: remux, probe, thumbnail, waveform peaks — read by URL
captions.ts     SRT and WebVTT, both directions
presets.ts      frame sizes, delivery presets, background looks
```

**`drawFrame` is the contract between preview and export.** The preview hands it
frames out of `<video>` elements; the exporter hands it frames mediabunny
decoded at exact timestamps. Neither knows the difference, which is the only
reason an export cannot silently disagree with what the user approved. Any
effect — layout, colour, mask, blend, transition, text — goes in
`compositor.ts` and nowhere else. Adding one to the preview alone is precisely
the bug this design exists to prevent.

**Colour and most effects compile to a CSS filter string.** `ctx.filter` runs on
the browser's own compositor; the `getImageData` loop that would do the same
thing costs orders of magnitude more. Only chroma key, posterize, pixelate and
the overlay effects need their own pass, and they are marked as such in
`effects.ts`. Highlights, shadows, whites and blacks are folded into brightness
and contrast — an approximation, and an honest one: the alternative was leaving
the controls out.

**Recorded files are remuxed on import.** MediaRecorder cannot write a Duration
or Cues into a WebM after the take ends, so `<video>` reports an infinite
duration and seeks by guessing. `media.ts` copies each file into a properly
indexed container once — same packets, no re-encode. The `.edit.webm` siblings
are kept, so re-opening a recording is free.

**The preview clock is `performance.now()`, not any element's `currentTime`.**
Elements stall and round; if one of them is the clock, every other layer chases
a moving target. Each element is corrected against the independent clock, and
only past `DRIFT_TOLERANCE_SEC`.

**`compositor.ts` runs in a worker as well as on the page, so it may not touch
the DOM.** `makeCanvas` picks `OffscreenCanvas` when `document` is absent, and
every `instanceof HTMLVideoElement`-style check is guarded by a `typeof` —
unguarded, those are a `ReferenceError` in the worker rather than a false
branch, which is exactly how the first worker export failed.

**The audio mix stays on the main thread.** `OfflineAudioContext` is not exposed
to workers, and reimplementing gain ramps and resampling by hand would be a
worse trade than one transfer. The mix crosses as planar float32 — an
`AudioBuffer` belongs to a context and cannot be transferred — and the worker
rebuilds it into `AudioSample`s. **Close each one after `add`**; mediabunny
holds decoded audio outside the JS heap and will tell you on the console when
you have not.

**Playback reads the proxy, the exporter reads the original.** `assetFile` takes
a `preferProxy` flag and `AssetUrls` sets it; `export-worker.ts` deliberately
has its own `originalFile` so the flag cannot be passed by accident. A file
delivered from a 720p proxy would be exactly the right length, exactly the right
codec, and visibly soft.

**A hidden tab invalidates any measurement.** Timers clamp to one second and
`requestAnimationFrame` stops, so a capture driven from a canvas runs at about
1 fps. `/dev-stress-check.html` refuses to run rather than print numbers that
are an order of magnitude low and still look like results.

**On-canvas handles read their box from `clipBox` in the compositor.** The
monitor overlay never computes layout of its own: a second implementation would
line up the day it was written and drift the first time either side changed —
the same failure the shared `drawFrame` prevents, one level down. If a handle
sits off the picture, the bug is in `clipBox`, and it is also a rendering bug.

**The PlaybackEngine must outlive renders.** `Monitor` keeps its callbacks in a
ref so the engine's effect depends only on the URL cache. When the callbacks
were in the dependency list, every edit tore the engine down and rebuilt it —
new `<video>` elements at readyState 0 — and the preview went blank on any
change. If the preview flickers, look here first.

**Elements are not ready when their `src` is set, and a seek does not finish on
the line that requests it.** `playback.ts` listens for `loadeddata`/`seeked`/
`canplay` and coalesces repaints to one per frame.

**Never put a callback that a parent re-creates each render into an effect that
makes the parent re-render.** `Studio` publishes its Record controls upward; with
`start`/`stop` in the dependency list, the parent's `setState` produced new
props, which produced new callbacks, which fired the effect again — React gives
up with "maximum update depth exceeded". Imperative handles go in refs and the
effect watches one boolean.

**Two `SelectItem`s must never share a value, and the current value must always
be in the list.** Radix keys on the value: duplicates stack both labels in the
trigger, and a missing one renders the trigger empty. Both have been shipped
here already — the export dialog and the sequence frame-rate picker build their
option lists through a `Set` for this reason.

**Clips from one take are linked, and every timeline edit propagates through
the group.** Move, trim, slip, split, delete, ripple delete and duplicate all
walk `linkedRefs` rather than the single clip they were handed. Without that, a
face on one track and the voice on another drift apart the first time either is
trimmed, and nothing says so until the lips stop matching the words. Breaking
the link is a deliberate act — "Detach audio", or "Unlink whole take".

Two details that are easy to get wrong: linked clips move by the same **delta**,
not to the same time, so a take whose tracks began a few milliseconds apart
keeps that offset; and a split gives the tail halves a **new** link id, because
one shared id across all four pieces would weld the timeline together.

**Keyframe times are clip-relative.** Moving or trimming a clip must not
re-time its animation. `splitClip` shifts the second half's keyframes back by
the split point for the same reason.

## How the recorder fits together

```
sources.ts    getDisplayMedia / getUserMedia  ->  one ArmedSource per file
     |
session.ts    one clock, N recorders, prepare() then a synchronous start()
     |
track-recorder.ts   one MediaRecorder -> one file, timing and pause spans
     |
storage.ts    OpfsWriter  ->  opfs-worker.ts  ->  OPFS (capture buffer)
     |
lib/sync.ts   finished take  ->  server  ->  ~/Cutline/.../recordings/
```

Things worth knowing before editing any of it:

**`start()` is synchronous on purpose.** All the expensive work — opening files,
constructing recorders — happens in `prepare()`. If a file open happened at
start time the tracks would begin milliseconds apart and drift out of lip sync.
Do not put an `await` inside the start path.

**Writes go through a worker because `createSyncAccessHandle` only exists
there.** The main-thread alternative, `createWritable`, stages the whole file in
a swap copy and commits on close — twice the disk for an hour of screen
capture, and everything lost if the tab dies first.

**Chunk writes are serialised through a promise chain.** `Blob.arrayBuffer()` is
async, so without the chain two chunks can land out of order and the WebM is
corrupt. The `dev-check` asserts the EBML magic bytes for exactly this reason.

**The container's own duration is not usable.** MediaRecorder cannot rewrite a
WebM header after the fact, so the file reports an infinite duration and seeks
badly. `TrackMeta.durationMs` is our own measurement and is the number the
editor must use. Files will need a remux pass on import.

**`offsetMs` is what makes separate files one take.** Every track measures its
start against the session's clock. Measured, not assumed — in practice it lands
under a few milliseconds.

## Non-goals

- **Not a cloud service.** No accounts, no cloud render, nothing leaves the
  machine. The server is local and bound to 127.0.0.1; recordings end up as
  ordinary files under `~/Cutline`.
- **Not cross-browser-at-any-cost.** Chrome and Edge are the target. WebCodecs
  and OPFS sync access handles are the reason.
- **Not a mixer at record time.** See the decisions above.
- **Not a general media converter.** mediabunny can transcode anything; this
  project uses it for one pipeline and should not grow an import matrix for its
  own sake.

## Known gaps

Whole areas that do not exist, so nobody has to grep to find out: audio effects
and an audio mixer, stabilisation, motion tracking, multicam, LUTs and any
professional colour management, curves and colour wheels, batch export, proxy
and optimised-media workflows, collaboration, cloud, plugins, stock asset
libraries, and the interchange formats (EDL, XML, AAF, OMF, FCPXML).

Some of the list is not reachable in a browser at all: ProRes and DNxHR
encoding, Dolby Vision, and a native plugin SDK. Those should be declined rather
than half-built.
- **Not a general media converter.** mediabunny can transcode anything; this
  project uses it for one recording pipeline and should not grow an import
  matrix for its own sake.
