/**
 * The director's playbook, served to agents over MCP: the `guide` tool, the
 * `/direct`, `/brief` and `/review` prompts, and `cutline://guide/*` resources.
 *
 * Written from real sessions, not from the tool list — the TreeFlux explainer
 * (nine minutes of Hinglish, ~1300 tool calls) is where most of it was learned.
 * Keep it true: when a tool changes, change the topic that teaches it.
 *
 * Pure strings: the server imports this.
 */

export interface GuideTopic {
  title: string;
  summary: string;
  body: string;
}

export const GUIDE: Record<string, GuideTopic> = {
  workflow: {
    title: "How to direct a video in Cutline",
    summary: "The phases, and the checkpoints where the client says yes.",
    body: `You are the director and the editor's hands. The client watches every edit land in their browser and can undo it, so work in phases and stop for a yes at each checkpoint.

1. **Orient.** get_editor_state, then get_brief. The brief is what the client and earlier agents already settled; its \`unanswered\` list is what you still need.
2. **Brief** (checkpoint). Ask what is unanswered — ask_client shows a form in their editor, or ask in chat — and record each answer with set_brief. Never build on a guess about layout, brand or tone. guide('brief') has the questions and sensible defaults.
3. **Look at the source.** analyze_media on each video (burned-in graphics, where the subject sits, cuts, silences), transcribe then transcript for what is said, contact_sheet to see it. guide('source').
4. **Treatment** (checkpoint). Write the plan in a few lines: layout, which stretches get graphics and which stay full frame, the look. Show the look: preview_themes on a representative frame, three candidates. Record the choice (set_theme, and set_brief({ decision })).
5. **Styleframe** (checkpoint). Build one scene fully, render_frame it, and get a yes before building the rest. A long build on an unapproved look is the most expensive mistake there is.
6. **Build.** start_turn, then the macros — layout_move, add_title, add_points, add_chips, add_stat, add_flow, add_bars, add_lower_third. They style themselves from the theme, pick free tracks and tag each clip's role, so the look can change later in one call. Raw tools (add_clip, add_keyframe…) remain for anything custom.
7. **Review** (checkpoint). render_frame each scene just after its elements land, contact_sheet across each block, audio_envelope after timing edits. Fix what you find. guide('qa').
8. **Deliver.** export_video once the checks look right; give the client the path, and list anything you are unsure of — above all, numbers on screen.

Log decisions as you go (set_brief({ decision })): the next agent reads them.`,
  },

  brief: {
    title: "The brief: what to ask the client",
    summary: "The questions, in order of how much they change the edit, and the defaults to offer.",
    body: `Ask only what get_brief lists as unanswered, most important first, and offer a default with each question so the client can just say yes. Record answers with set_brief as they come.

1. **Goal and audience** — "What should someone do or understand after watching, and who are they?" Default: none; this one must come from the client.
2. **Platform** — "Where will it be watched?" It sets aspect ratio and pace. YouTube 16:9, calm; Reels/Shorts 9:16, faster, bigger type; a landing page, silent-first with captions.
3. **Layout** — show, don't describe. Offer: side-panel (speaker in a panel, graphics beside — best for dense explainers), b-roll (full-frame speaker, graphics cut away full screen — best when the speaker is the draw), pip (graphics own the frame, speaker in a corner — screen recordings), lower-thirds (names and key points only — interviews), graphics-only.
4. **Brand** — "A logo, colours or fonts to follow?" If they send a logo, import it and run theme_from_media on it. Default: a built-in theme that suits the footage.
5. **References** — "A video or design whose look you like?" Import it and contact_sheet it; write down what to take from it (set_brief references with a note).
6. **Tone** — calm, premium, energetic, playful, serious. It picks motion: fades for calm, pop for energetic.
7. **Language of on-screen text** — often not the spoken one (Hinglish speech, English graphics).
8. **Captions** — wanted? In which language?
9. **Rules** — anything that must or must not happen. Always propose one: "Numbers on screen are checked with you first."

Then the theme: preview_themes, let them pick, set_theme.`,
  },

  source: {
    title: "Look at the source before deciding anything",
    summary: "What to check in the footage and the transcript, and why.",
    body: `- **analyze_media** first. It finds graphics already burned into the video (a card, a logo — the TreeFlux source had its own "Smart Contract" card from 1 to 21.5 s), where the subject sits horizontally (crop a panel around it), scene cuts and silences. Leave stretches with burned-in graphics full frame, or your panel crops them into slivers.
- **contact_sheet** the whole video: one shot or many, talking head or screen recording, how busy the background is, what colours the footage has — the theme's accent should sit with them (TreeFlux's amber came from a practical lamp).
- **transcribe** (Hindi: language "hi"), then **transcript** for word times. Read it critically: the connected model may be weak for the language. Where two runs or two models disagree — or a number sounds odd — ask the client before putting it on screen. "Level 3 = 60" came out as "7" from one model.
- **audio_envelope** before cutting on silence.

Write what you learned into the brief as decisions: "Source has its own card 1–21.5 s: keep full frame there."`,
  },

  layouts: {
    title: "Layouts and rhythm",
    summary: "Side panel, B-roll, picture-in-picture, lower thirds — when and how.",
    body: `**side-panel** — the speaker in a rounded card on one side (panelWidth of the frame, default 25%), graphics in the rest. layout_move({ at, to: "panel" }) moves the speaker in over theme.motion.move seconds; layout_move({ at, to: "full" }) brings them back. Centre the crop on the subject (subjectX from analyze_media).
**b-roll** — the speaker stays full frame; graphics cut in full screen over a scrim for a few seconds at a time. Good when the face carries the video.
**pip** — graphics or a screen recording own the frame; the speaker sits small in a corner (layout_move to "pip").
**lower-thirds** — add_lower_third for names and roles, a point or two; nothing else.

Rhythm, from the TreeFlux edit:
- Graphics blocks of 20–90 s, each split into scenes of 8–25 s, one idea per scene.
- Go back to full frame at section changes and rhetorical questions ("Now, why would anyone…?") — the face lands those. Never for less than ~3 s: two moves in quick succession look like a glitch.
- Start a layout move ~0.3 s before the sentence it serves; let the first element arrive as the move settles.
- Keep full frame wherever the source has its own graphics.`,
  },

  themes: {
    title: "Choosing and changing the look",
    summary: "Built-in themes, brand themes, overrides and restyling.",
    body: `- **list_themes** describes the six built-ins: studio-dark, clean-light, editorial, bold-creator, corporate, warm-documentary.
- **preview_themes({ time })** renders one frame of the edit in several themes side by side. Show the client three that fit the brief; a picture beats "which style do you like?".
- **theme_from_media({ assetId })** reads a logo or a reference frame and proposes palette overrides with readable contrast. Apply with set_theme({ themeId, overrides }).
- **set_theme** with themeId picks a built-in; overrides adjust any token (palette, fonts, type sizes, radius, motion, panel). restyle (default) restyles every clip the macros made, the background and the captions.
- A restyle changes colours and faces, not sizes or positions. A face with wider letters can crowd a row of chips: render_frame after.
- Fonts: each theme leads with a web font that loads for preview and export alike. A brand font must be on Google Fonts or installed on this machine; otherwise the fallback shows.
- Contrast: text on the background wants 4.5:1, large type and graphics 3:1. theme_from_media checks it; check your own overrides the same way.`,
  },

  graphics: {
    title: "Writing and timing graphics",
    summary: "What goes on screen, how much, and when.",
    body: `- **One idea per scene.** A kicker (2–4 words, the section), a title (under ~8 words), then at most 3–6 supporting items.
- **Time to the word.** Use transcript word times: an item appears when its word is said, not before the sentence starts. Titles land 0.1–0.3 s after the scene's first word.
- **Stagger** related items by theme.motion.stagger; exits happen together at the scene's end, 0.15 s before the next scene's first entrance.
- **Pick the device for the idea**: a sequence → add_flow; a list of rules or steps → add_points; tags or options → add_chips; one striking number → add_stat; a ladder or comparison of numbers → add_bars (scale "log" when they span orders of magnitude); names → add_lower_third.
- **Numbers are exact or absent.** If the transcript was unsure, ask; say so in your report.
- **Write in the brief's on-screen language**, short and concrete. Paraphrase the speaker; do not caption them in the graphics.
- Keep graphics clear of faces and inside the margins; the macros do both when the speaker is in a panel.`,
  },

  qa: {
    title: "Reviewing an edit",
    summary: "What to render and what to look for before calling it done.",
    body: `For every scene: render_frame just after its last element lands, and once mid-way. For every layout move: one frame mid-move. Across each block: contact_sheet.

Look for:
- text overlapping text (two lines placed at the same y in consecutive scenes is the classic);
- an element drawn before the thing it points at exists (a connector to a card that arrives later);
- rows whose spacing is uneven, labels detached from their bars or nodes;
- anything under the speaker's panel or over a face;
- a source's own graphics sliced by a crop;
- the layout move leaving a sliver of something at the frame's edge.

Then audio_envelope if you changed timing. Report what you checked and what you fixed, and anything still uncertain — numbers first.`,
  },

  gotchas: {
    title: "Things that bite",
    summary: "Hard-won details about the editor and the bridge.",
    body: `- **The tab is the source of truth.** Every tool edits the project open in the client's browser. If they switch projects in that tab, your calls go to the other project — check get_editor_state when in doubt. Never open the client's project in a second tab.
- **One undo step per turn.** start_turn before editing, again for each new request.
- **Long calls answer "running".** transcribe waits up to 90 s, then returns progress; call it again with the same assetId to keep waiting. ask_client does the same while the client fills the form.
- **Tracks.** The macros find free overlay tracks and add more when needed; raw add_clip needs a track that has no clip overlapping in time, and later video tracks draw on top.
- **Keyframe times are clip-relative**, positions are 0..1 of the frame, sizes are pixels at 1080p.
- **Text in a clip is one block**; wrap long lines with \\n yourself.
- **Transcripts are cached** beside the file; transcribe({ force: true }) to redo one with another service.
- **The server may restart** (development saves); calls wait for the editor to reconnect and turns keep their names.`,
  },
};

export const GUIDE_TOPICS = Object.keys(GUIDE);

export function guideIndex(): string {
  return [
    "Cutline director's guide. Read 'workflow' first; the others when you reach that phase.",
    "",
    ...Object.entries(GUIDE).map(([id, t]) => `- ${id}: ${t.title} — ${t.summary}`),
  ].join("\n");
}

export const PROMPTS = {
  direct: {
    title: "Direct this video",
    description: "Act as the director for the project open in Cutline: brief, look at the source, propose, get a yes, build with the macros, review.",
    text: (goal?: string) => `You are directing the video open in Cutline, the editor in my browser. ${goal ? `What I want: ${goal}\n\n` : ""}Work in phases and stop for my yes at each checkpoint:
1. get_editor_state and get_brief. Read guide('workflow').
2. Ask me whatever the brief still lacks (ask_client or here), record it with set_brief.
3. Look at the source: analyze_media, transcribe + transcript, contact_sheet.
4. Propose a treatment in a few lines and show preview_themes on a representative frame. Wait for my choice.
5. Build one scene as a styleframe, show it, wait for my yes.
6. start_turn, build the rest with the macros, then review every scene (guide('qa')) and fix what you find.
7. Tell me what you checked and anything you are unsure of, then ask before export_video.`,
  },
  brief: {
    title: "Interview me for the brief",
    description: "Ask the client what the brief still lacks — goal, platform, layout, brand, references, tone — and record it.",
    text: () => `Read get_brief and guide('brief'). Ask me only what is still unanswered, most important first, each with a sensible default I can accept. Prefer ask_client, which shows me a form in the editor. Record every answer with set_brief, then show me three themes with preview_themes and set the one I choose.`,
  },
  review: {
    title: "Review the edit",
    description: "Check every scene of the current edit against guide('qa') and report or fix what is wrong.",
    text: () => `Review the edit open in Cutline as a picky editor would. Read guide('qa'). Walk every block: render_frame each scene after its elements land and mid-way through each layout move, contact_sheet across blocks, audio_envelope if timing changed. List every problem with its time; fix the clear ones in one start_turn, and ask me about anything that is a matter of taste or a number you cannot verify.`,
  },
} as const;
