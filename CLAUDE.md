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
| Auto-captions (any OpenAI-compatible speech-to-text) | done |

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

**In Docker** (`docker compose up -d`, then http://localhost:5311) the same
server serves the built app, with `~/Cutline` mounted at `/data`. It listens on
0.0.0.0 inside the container (`CUTLINE_HOST`) and the publish rule
`127.0.0.1:5311:5311` keeps it off the network; a different host port needs
`CUTLINE_PUBLIC_PORT`, or the Host and Origin checks refuse the browser. A
provider at 127.0.0.1 — whisper.cpp on the host — is reached through
`CUTLINE_LOCALHOST_ALIAS=host.docker.internal`, and still counts as local. Two
things do not survive the container: the cursor track (the macOS sampler cannot
see out of a Linux container) and GPU transcription (no Metal inside Docker on
a Mac, so whisper.cpp runs on the host). `transcribe-check` runs against it with
`CUTLINE_WEB_URL` and `CUTLINE_API_URL` pointing at port 5311.

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
The palette is true neutrals — white surfaces in the light scheme, black in the
dark — with a lime accent (`--primary`) kept for buttons, badges, focus rings
and selected states. **No background or shadow is tinted green**: an earlier
green-biased palette read as muddy, and the user asked for it gone. A selected
card gets a lime border on a neutral fill, not a lime wash.
`--surface-deep` (near-black) sits behind anything that stands in for a
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

`context-menu.tsx` is hand-edited, and must stay so after a regenerate: its
items select only on a primary-button release. Radix runs the item under the
pointer on *any* pointerup, and Chrome on macOS opens a context menu on
mousedown — so a right-click on a clip on the bottom track, where the menu has
to shift up to fit and opens under the pointer, ran Duplicate or Delete the
moment the button came up.

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
effect, a colour grade and a dissolve actually reached the file. The dissolve
check exists because every layer used to overwrite the transition's alpha with
its own opacity: dissolves did nothing, in preview and in export, for as long as
they had existed, and it was the first agent to look at its own frames that
noticed.

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
`bun scripts/headless-check.ts <harness page>` runs any harness in headless
Chrome instead — visible to the page, with a throwaway profile, autoplay
allowed (or the synthetic microphone records nothing) and `gc` exposed so heap
figures mean what is held rather than what is uncollected. It is how a long
take is measured unattended: `dev-stress-check.html?seconds=600`.

**Judge server memory by physical footprint, not RSS.** `ps` showed the server
at 372 MB after a remux; `vmmap -summary` showed a 59 MB footprint — the rest
was clean, reclaimable pages. The remux worker is ended after 30 s idle, which
gives its heap back.

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

**Import never holds a whole file in memory.** The remux runs on the server —
`POST /api/recordings/:id/remux`, mediabunny's `FilePathSource` to
`FilePathTarget` on a Bun worker, so a long take neither passes through the
browser nor stalls the thread answering range requests. What must happen in the
page (proxies need the browser's encoder; a server that cannot remux falls back
to the page) writes through `StreamTarget` into `positionalUpload`: each chunk
is a `PUT ?upload=<id>&at=<byte>` into a part file, and `final=1` renames it.
Positional, not append-only — the muxer goes back at the end to write the
duration and the Cues, and an append-only WebM would have neither, which is the
defect the remux exists to fix. Chrome only streams request bodies over HTTP/2,
hence pieces rather than one streamed request. Waveforms decode through
`AudioSampleSink` a batch at a time, all channels, instead of `decodeAudioData`
on the whole file.

**A bad track is refused, not retried, and never sinks the take.** An empty or
unreadable file makes the remux route answer 422 with the reason — not 500,
which the page read as "server cannot" and retried itself, turning the real
reason into a range error. `importSession` leaves such a track out, reports it
through `onSkip`, and fails only if nothing is left; the studio warns at stop
when a device delivered nothing.

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
`export_video` renders through the same `exportProject` as the Export button
and saves under `exports/`; the server refuses a name that already exists, so
an export is never overwritten.

**A turn belongs to the project, not the socket.** Turn state is keyed by
project id and kept on `globalThis`, not in the module. It first lived on the
`AgentBridge` object, which the editor's effect rebuilds on a reconnect, a lock
change or a hot reload; then in a module-level map, which a hot reload of
`agent-bridge.ts` or of anything it imports evaluates afresh. Both times one
request quietly became several undo steps, the later ones named "Agent edit".
The page id, the holds, transcriptions in flight and the live bridge sit beside
it for the same reason — a new page id made the server take the page for a
stranger. A reload is a new page. The server also remembers each project's
last `start_turn` and names it with every call, so a reloaded page, or an
editor the hold moved to, names the step the same; after a server restart,
which empties that, the tab's own copy stands.

**A call belongs to the page, not the socket.** The server keeps a call
pending for the page it went to and takes the answer from any socket of that
page; the tab sends each answer on whatever socket it has by then (`deliver`,
with an outbox while it has none). A page that drops its socket has 10 s to
come back before its calls fail with "The editor closed before it answered." —
a `transcribe` waiting its 90 s used to fail that way the moment the bridge was
rebuilt, while the work carried on in the tab. An edit that finishes after its
bridge was rebuilt commits through the bridge serving the project now
(`current()`).

**A reconnect is not a touch.** Calls go to the editor the user touched last,
and after a restart every editor reconnects in no particular order — a hidden
tab's timers run late. `mcp-check`'s restart step once put its marker in a
different project, open in another browser that happened to reconnect first.
So each `hello` carries the page's `touchedAt` (loaded or last focused), the
server gives the editors 3 s after a start before it picks one, and when the
holder the user touched last drops its socket without closing it (close code
1006, not 1000/1001/1005), new calls wait up to the 10 s grace for it rather
than going elsewhere. With no editor at all, a call made within 10 s of a start
waits for one instead of reporting that none is open. `mcp-check` reads the
editor state after its restart and edits only if the call reached its own
project.

**One bridge per page.** A new `AgentBridge` stops any live one, a close or a
message from a socket that is no longer current is ignored, and each `hello`
carries a `pageId` so the server drops a stale second socket from the same
page. The server logs every editor that connects, with its browser and whether
it is visible — that log is how the next item was found.

**Two locks, because a `BroadcastChannel` stops at the browser.** The page's
own lock covers tabs of one browser. The server covers the rest: every editor
that holds its browser's lock opens the bridge, and the server names one holder
per project — the first to connect — and tells every editor of that project
whether it holds it. An editor saves only when both agree (`canWrite` in
`editor.tsx`); the other shows "Open elsewhere · not saving", whose button
claims through both locks. When the holder closes, the longest-open editor is
promoted. After a restart editors reconnect in any order, so each `hello`
carries `wasHolder`, and an editor that held the project before takes it back
from one that was only given it by default. Agent calls go only to holders, and
a non-holder refuses edits itself in case one is in flight. With the server
down, only the browser's lock is in force. `bun scripts/lock-check.ts` checks
all of it with two stand-in editors — and, with one page on three sockets, that
a call outlives the socket it went out on, that every call names the turn, and
that a page which does not come back fails its calls after the grace.

**Stateless, with its own token.** A fresh MCP server per request, so a restart
under `bun --watch` strands no client session. The bearer token lives in
`~/Cutline/mcp-token` (0600), because the per-run page token changes on every
start. A request carrying a browser Origin is refused.

**Checking it.** `bun scripts/mcp-check.ts setup` creates a test project and
prints a `?project=` link. Open it, then `bun scripts/mcp-check.ts run <id>`
drives it as a real MCP client. It checks that every action has a tool, and
that bad auth and malformed calls are refused. It checks that the rendered PNG
has the layer where it was placed, and that one undo reverts a whole turn
exactly — also a turn the server restarted in the middle of, which the check
causes by writing `server/index.ts` back unchanged. It checks that a planted two-second gap shows in the envelope, and
that the tab's JSON equals what autosave writes, byte for byte.
`cleanup <id>` removes the project.

## Directing: brief, theme, storyboard and the Director

**Every project carries a brief and a theme, and every agent reads them
first.** The brief (`project.brief`) is what the client said: goal, audience,
platform, tone, layout (side panel, B-roll, picture-in-picture, lower thirds,
graphics only), on-screen language, captions, brand, references, standing
rules, and a log of decisions. `get_brief` returns it with the questions still
unanswered; `set_brief` records answers and appends to the log. The editor's
Brief tab is the same document, so the client sees what the agent was told and
can change it — and the second agent to open a project does not re-ask what
the first one learned.

**A theme is tokens, not styles** (`editor/themes.ts`): a palette, a display and
a body font stack, a type scale, radius and stroke, motion (how things enter,
how long a layout move takes, the stagger between items, how they leave) and
where the speaker's panel sits. Six are built in. A clip made from tokens
carries a `role` — title, chip, card — and `setTheme` restyles every clip that
has one, with the background and the captions, so a finished edit changes its
look in one step. Colours and faces change; sizes and positions do not, so a
face with different widths can crowd a row of chips: look after a restyle.

**The playbook ships with the server** (`editor/agent-guide.ts`). The
`instructions` every MCP client receives tell an agent to work as a director —
brief, look at the source, propose, get a yes on a styleframe, build with the
macros, review — and the `guide` tool, the `cutline://guide/*` resources and the
`/direct`, `/brief` and `/review` prompts carry the detail: what to ask the
client, what to check in the footage, layouts and rhythm, themes, graphics,
review, and the gotchas. `guide` and `list_themes` are answered by the server,
so an agent can read them before any editor is open. Agents follow the guide
literally: when a tool changes, change the topic that teaches it. `docs/DIRECTOR-PLAN.md` is the roadmap, with what is
done and what is next.

**Macros make graphics from the theme** (`editor/agent-macros.ts`):
`layout_move` (the speaker to a side panel, picture-in-picture or full frame,
cropped around `subjectX`), `add_title`, `add_points`, `add_chips`, `add_stat`,
`add_flow`, `add_bars`, `add_lower_third`, `add_backdrop`. Each measures its
text on a canvas in the theme's own faces, lays out in the space beside the
speaker's panel — as it will be once a layout move settles, not while it is
under way: the first version wrapped a title to the whole frame because it
started mid-move — stacks under what the scene already shows, finds tracks
with room, and tags each clip's role. One reducer action per clip, inside the
agent's turn. The TreeFlux edit took ~1300 raw calls; the same scenes are a
few dozen macro calls.

**Web fonts reach the export.** Canvas text uses a face only once it has
loaded, and the export worker has no document, so it never saw the page's CSS
fonts: exports drew fallbacks while the preview showed the real face.
`lib/fonts.ts` fetches each family a project's text uses from Google Fonts
once, registers it for the page, and hands the same files to the export
worker, which registers them before its first frame; frames an agent renders,
the preview and the macros' measurements load them first too. A family
installed on the machine is used as it is. Offline, text falls back, as it
always did.

**The client chooses from pictures and answers in the editor.**
`preview_themes` draws one frame restyled in several themes side by side
(`editor/styleframes.ts`); `theme_from_media` reads a logo's or a reference
frame's colours and proposes an accent kept at 3:1 on the theme's background.
`analyze_media` (`editor/analyze.ts`) decodes small grey frames across a video
and finds burned-in graphics against each shot's median frame, the subject
from where the picture moves, cuts and silences. On TreeFlux it found the
source's own cards at 1.8–7.2 s and 9–22.4 s and the speaker at 0.54 — which
had taken ffmpeg and a hand-written diff. In the region the subject is in, an
appearance counts as a graphic only past 3 s: a hand is not a card.
`ask_client` opens a form in the editor rather than using MCP's elicitation,
which needs a session held open between client and server; this server is
stateless on purpose, and the editor is where the client already is.

**The storyboard is the whole edit as one document.** Scenes in order, each
with a layout and components anchored to transcript words; `storyboard.ts`
compiles it into clips through the macros. A word anchor is the first time a
phrase is said after the previous anchor, allowing one letter off or a word
prefix, because transcripts misspell. A compile replaces only its own clips:
each is tagged with its scene and component, a clip the user edits by hand is
marked `userEdited` and kept, and deleting a compiled clip locks its scene —
the dispatch wrapper in `editor.tsx` does both. The speaker's layout moves are
rebuilt from the whole storyboard every time, so a partial compile cannot leave
them inconsistent. The acceptance test was the TreeFlux edit: about 1,300
hand-placed calls, and the same edit as 24 scenes of JSON compiles to 294 clips
in two seconds.

**The Director panel runs the agent in the tab.** `director.ts` is the loop:
it calls `AgentBridge.execute` — the same executors, validation and one undo
step per request as an MCP agent — and its model calls go through
`/api/ai/chat`, which answers with a job, because a reply with a dozen tool
calls outlasts a request; Stop deletes the job and aborts the call upstream.
`server/chat.ts` translates one message shape (`src/lib/chat-protocol.ts`) to
Anthropic's Messages API or OpenAI's chat completions. A frame a tool returns
goes inside the tool result for Anthropic, and as a following user image for
OpenAI, whose tool messages carry text only. Anthropic gets cache breakpoints
on the system prompt (which covers the ~85 tool schemas) and on the
conversation so far, since every step resends both. A provider runs the
Director once it has a `chatModel` that answered a few-token probe, and the one
connected last is used; every call is logged to `~/Cutline/usage.jsonl`. The
thread is kept per project in localStorage, but the conversation is not:
frames and tool output would crowd out crash recovery, which lives there too,
so after a reload what was said goes back to the model as a recap.
`bun scripts/director-check.ts` checks the translation against stand-in
services; `serve` keeps a scripted model connected to drive the panel by hand.

**Checks see the frame, and figures are confirmed.** `lint.ts` finds
overlapping text, text running off its card, anything off-frame or outside
title-safe, text over the speaker's face, and text on screen too briefly to
read. Boxes come from `clipBox` at moments after entrances settle. The face is
an estimate — a fifth of the source's width around `subjectX`, in the upper
half of the picture — and the report says so when `subjectX` was guessed.
Contrast is measured on frames `renderFrames` draws: the text's colour, mixed
at its opacity, against the median of the box's pixels that are not that
colour — so a card the theme meant to be dark but the video shows through is
caught. `facts.ts` reads every number on screen and looks for it in what was
said a few seconds around it, as digits (joining the transcript's "21 ,600"
splits) or as a common English or Hindi number word; one nobody said, and
anything an agent flagged with `set_fact`, is listed to confirm. `correctFact`
replaces a whole value — the 7 in 17 and in 7,000 is left alone — in every
text clip and in the storyboard, so a recompile keeps the fix. The Director tab
shows both, with no model connected.

**Notes, versions and locks.** A note is a marker with a `pin`, 0..1 of the
frame: the client drops one by clicking the picture in Note mode, and
`list_notes` tells an agent what is under it at that moment — from `clipBox`
and `hitTest`, as the handles are — so "make this bigger" arrives with the
clip, scene and component it means. `resolve_note` records what was done
beside the note. Versions are snapshots beside the project, in
`projects/<id>.versions/` (the document first and its meta last, each written
atomically, so a version is listed only once it can be opened), and restoring
one is a reducer action in the tab, so History keeps what it replaced. A track
the user locked is theirs: the bridge refuses an agent's edit to it, the macros
never pick it, and a compile leaves compiled clips on it alone. Compare looks
draws the frame at the playhead in three themes through `renderStill`; one
click restyles the edit.

**The workspace holds what is reused; a project copies it.** Brand kits,
looks, recipes and references live under
`~/Cutline/workspaces/local/{brand-kits,looks,recipes,references}/` — a JSON
document per item, its files in a folder beside it, and a `version` bumped on
every save (`server/workspace.ts`). Applying one *copies* it in: a recipe fills
the brief's gaps and never overwrites what the client said; a brand kit's
colours and faces become the theme (the accent kept readable) and its logo,
intro and outro are imported into the project's media, in a *Brand* bin; a
reference is attached to the brief with its file beside the footage. The brief
records `sources` — which kit, recipe and look, and which version — so a kit
edited later can be offered as an update instead of changing a finished video
behind the client's back. The same functions serve the Brief tab's buttons and
the agent's tools (`list_brand_kits`, `apply_brand_kit`, `list_recipes`,
`apply_recipe`, `list_references`, `attach_reference`), as the macros do.
Create is the front door: an instruction, the footage, a recipe, a kit and a
look, then the editor opens with the Director already working on it.

## Transcription and AI services

**Not tied to one engine or one machine.** Transcription goes through a
provider the user connects where a feature first needs it — the Captions panel,
with presets for this Mac, OpenAI, Groq, OpenRouter and ElevenLabs — never a
settings page before recording. Not everyone can run a large model, so the
hosted services stand beside the local one as equals. `server/stt.ts` has one
adapter per kind of API: OpenAI-compatible (OpenAI, Groq, OpenRouter,
whisper.cpp, speaches, LocalAI) and ElevenLabs. Each says how long a part it
takes and how big an upload; `transcribe.ts` does the rest the same for all.
Adding a service is an adapter and a preset. The one connected last is the
one used; the Captions panel names it, says whether audio leaves the machine,
and switches between connected services. The server makes every call and
keeps keys in `~/Cutline/ai.json` (0600); the page never sees one. Adding a
provider probes it with a quarter-second of silence, so the answer is
*transcription ✗, and why*, not "connected". LM Studio, as of September 2026,
cannot transcribe.

**Services differ where it hurts, and the adapter absorbs it.** OpenAI and
OpenRouter refuse uploads over 25 MB, and OpenRouter gives the model 60 s per
request, so parts are sized from the audio's bitrate and the service's limits.
whisper.cpp — recognised by its `Server: whisper.cpp` header — is sent two
things no other service may be. Its word tokens are bytes, which split each
Hindi character into two `\uFFFD` halves, so it is asked for one word per
segment (`max_len=1`, `split_on_word`). And over a long part it falls into
repeating a phrase — nine minutes of Hindi came back as "re re re…" from the
thirtieth second — so its parts are two minutes. Every part reaches two seconds
into its neighbours and each word is kept from the part its middle falls in;
`dropLoops` removes any phrase repeated more than three times running, whatever
produced it.

**Then every hole is heard again.** Hosted Whisper drops the last seconds of
each thirty-second window it decodes: nine minutes of Hindi through OpenRouter
lost 141 s of speech, and cutting 26 s parts only moved the holes to the ends
of the parts. So any stretch over 2.5 s with no word in it is sent again,
centred in a short part of its own — the same video then came back with one
3 s gap, a real pause. A hole that was silence costs a few seconds of audio.
Hosted parts go four at a time, since a request took ~35 s through OpenRouter
however short its audio; whisper.cpp takes them in turn. Even so, whisper.cpp's medium model is weak on Hinglish;
large-v3-turbo is the local model to run:

```
whisper-server -m ~/.cache/whisper-cpp/ggml-large-v3-turbo.bin \
  --inference-path /v1/audio/transcriptions --convert -l auto --port 8178
```

**Transcripts live in the file's time, captions in the timeline's.**
`server/transcribe.ts` cuts long audio into ten-minute parts by copying packets
— a trimming conversion makes mediabunny decode, and Bun has no audio decoder,
so it discards the track as "undecodable" — shifts each part's words back by
where its first packet really starts, and caches the result beside the file.
whisper.cpp reports words as tokens (" Cut", "line"): a piece without leading
space continues the word before it. The transcript is stored on the asset;
`wordsOnTimeline` maps it through the clips, so a trim never invalidates it,
and `captionsFromWords` breaks lines at pauses and sentence ends, lets a line
run a little long to finish its sentence, and otherwise breaks at a comma.

**One runner behind three doors.** A clip's right-click, a media-pool item's
and the Captions panel all call `runAutoCaptions` in
`components/editor/auto-captions.ts`. It builds the captions from the project
as it is when the transcript *arrives* — read through `historyRef`, not the
render that started it — so a caption edited during a minute of transcription
survives, and it replaces only cues that overlap this asset's clips, so a
second speaker's captions are kept. Transcript, captions and switching them on
are one undo step. `captionsForAsset` in `editor/transcript.ts` is that rule,
shared with the agent.

**The agent transcribes through the same job.** MCP's `transcribe` starts it
in the tab, waits up to 90 s (a relayed call gets 120), and answers `running`
with progress if it is not done; calling again joins the same job rather than
starting another. When it finishes, the transcript lands on the asset as the
agent's edit, in its turn's undo step, and `transcript` reads it back as words
at their timeline times — what an agent needs to time a cut, a title or an
animation to a word.

**Captions have a lane on the timeline**, under the ruler, once there are any.
`trackAtClientY` counts its height: a row between the ruler and the tracks that
the drag maths did not know about would drop a dragged clip one track off. The
Captions panel folds its Style section by default — open, it is taller than
most panels and left the cue list no height, so generated captions looked
missing.

**Settings is a place to manage, not a gate.** Services are still connected
where a feature first needs them; Settings lists them, says which one captions
and the Director use, and can switch or re-probe one. Agents shows the
registration line with the token's last four characters (never the token), can
rotate it — every agent registered with the old one then stops, which is the
point — and lists who has called since the server started, with the editors
their edits land in. Permissions live in `~/Cutline/agents.json`
(`server/agents.ts`) and are enforced where the call arrives: the MCP relay
refuses an export or an import that is turned off, and the tab refuses to
delete a clip with no scene, component or role on it, because whose clip it is
is a question only the tab can answer. Usage reads `~/Cutline/usage.jsonl`,
which model and transcription calls append to: tokens and minutes by day, model
and project — not money, which is the provider's to say.

**Distribution is a decision, not a side effect.**
`.github/workflows/image.yml` builds the container image for amd64 and arm64
and pushes it to GHCR — only on `workflow_dispatch` or a `v*` tag, never on a
merge. `scripts/package.ts` makes single binaries: it writes
`server/embedded.ts` from what Vite built (Bun's `--compile` embeds files
imported with `{ type: "file" }`), compiles for one target or all of them, and
puts the empty module back, because a stale one would make `bun run dev` serve
yesterday's app. `server/static.ts` serves the embedded copies when there are
any and `dist/` otherwise; the page leaves with the run's token either way.

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
sits off the picture, the bug is in `clipBox`, and it is also a rendering bug. Text boxes follow the line's alignment and letter
spacing: every one used to be centred on its anchor, which put the handles of
left-aligned titles half a line to their left — `lint_scene`, reading the
same boxes, is what noticed.

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

lib/cursor-capture.ts  ->  /api/cursor  ->  server/cursor.ts  ->  cursor.jsonl
```

**The cursor track is recorded by the server, not the page.** A page only
receives pointer events over its own window, and during a screen recording the
user is somewhere else. The server samples the OS cursor at 60 Hz (macOS: a
JXA loop over `NSEvent`, no permission needed) while the recorder page holds a
WebSocket open; the socket's lifetime is the sampler's, so a dead tab stops it.
Times are the session clock's content time — `clockOriginWall` from the
session, pauses cut out on the server — the same base as `offsetMs` and
`durationMs`. It is best-effort by design: a missing server or an unsupported
platform costs the take its cursor track, never the take. `dev-check` asserts
the pause is cut out by checking that the last sample lands at the recorded
length rather than ~a pause later.

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

**A live take holds a Web Lock; a dead one does not.** Both have files in OPFS
and no `meta.json`, so nothing else tells them apart. `RecordingSession` takes
`cutline-recording:<id>` before it opens a file and releases it only after
`meta.json` is written (or on abort); the browser releases it if the tab dies,
and `navigator.locks` spans the origin's tabs. `recover.ts` offers a take only
when neither meta nor lock exists, and quietly deletes takes whose every file is
0 bytes — an abort that races the final chunk leaves exactly that.

**A crash cuts a file mid-block, and a demuxer then drops the whole last
cluster.** Measured on a still screen capture: 300 bytes missing from a
57-second file read back as 30 seconds. MediaRecorder writes unknown-size
clusters, which are valid wherever they end on an element boundary, so
`webm-salvage.ts` walks the final cluster and recovery truncates the file to its
last complete element — 56 of the 57 seconds come back. The truncate goes
through the OPFS worker's sync handle; `createWritable` would first copy the
whole file to a swap file.

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
