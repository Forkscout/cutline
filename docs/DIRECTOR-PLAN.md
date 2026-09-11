# Director plan — instruction in, finished edit out

The promise: **the user describes the video; the agent makes it; the user
approves once and never hand-edits.** Not "zero questions" — brand choices and
on-screen numbers are the client's to confirm — but one approval, zero manual
editing. Everything the agent does stays a real, undoable edit on the
timeline, never a black-box render.

Status as of 12 Sep 2026. ✅ done · 🟡 in progress · ⬜ next.

## 1. Status

| Piece | Status | Where |
|---|---|---|
| Brief in every project (goal, audience, platform, layout, brand, references, rules, decisions) | ✅ | `project.brief`, Brief tab, `get_brief`/`set_brief` |
| Design theme as tokens, 6 built-in looks, restyle in one call | ✅ | `editor/themes.ts`, `set_theme` |
| Director playbook for any MCP agent (instructions, `guide`, `/direct` `/brief` `/review`, resources) | ✅ | `editor/agent-guide.ts` |
| Calls and turns survive reconnects and restarts | ✅ | bridge |
| Any speech-to-text provider, holes re-heard | ✅ | `server/stt.ts`, `server/transcribe.ts` |
| Docker, one command on any OS | ✅ | `Dockerfile`, `compose.yaml` |
| Macros: `layout_move`, `add_title`, `add_points`, `add_chips`, `add_stat`, `add_flow`, `add_bars`, `add_lower_third`, `add_backdrop` | ✅ | `editor/agent-macros.ts` |
| Web fonts in preview and export alike | ✅ | `lib/fonts.ts` |
| Storyboard compiler + Storyboard view | ✅ | `editor/storyboard.ts`, `storyboard-view.tsx`, `set_storyboard`/`compile_storyboard` |
| Director panel inside the editor (no Claude Code or MCP setup needed), ⌘K | ✅ | `editor/director.ts`, `director-panel.tsx`, `server/chat.ts` |
| `analyze_media` (burned-in graphics, subject from motion, cuts, silences) | ✅ | `editor/analyze.ts` |
| `preview_themes` sheet, `theme_from_media`, `ask_client` form | ✅ | `editor/styleframes.ts`, `themes.ts`, `client-questions.ts` |
| Self-QA (`lint_scene`) and facts to confirm | ✅ | `editor/lint.ts`, `editor/facts.ts`, `checks-panel.tsx` |
| Styleframes, note pins, versions, locks | ✅ | `styleframe-compare.tsx`, `monitor-overlay.tsx`, `versions-menu.tsx`, `server/store.ts` |
| Workspace Studio: brand kits, looks, recipes, references | ✅ | `server/workspace.ts`, `workspace-studio.tsx`, `editor/workspace-apply.ts` |
| Create flow, Settings (AI services, agents, usage) | ✅ | `components/create.tsx`, `components/settings.tsx`, `server/agents.ts` |

## 2. The rule: workspace or project

**Anything reused across videos lives in the workspace (main UI). Anything
that makes *this* video lives in the project (editor).** A project *copies*
what it uses from the workspace and remembers where it came from, so a
finished or exported video never changes behind the user's back when a brand
kit is edited later.

| Workspace (main UI) | Project (editor) |
|---|---|
| Brand kits | The brief (with a snapshot of the brand kit it used) |
| Looks (themes) — built-in, custom, derived | The project's theme (a copy of a look, plus overrides) |
| Recipes | The recipe applied (defaults written into the brief) |
| References library | References attached to this brief |
| AI services, agent connections, usage & plan | The Director thread, storyboard, notes, versions, facts |

## 3. Main UI (workspace)

Navigation today: Record · Library · Edit. Proposed:

**Create · Record · Library · Edit · Studio** — and a Settings gear and a
credits pill on the right of the header.

- **Create (new home).** One large prompt, "What do you want to make?", beside
  a drop zone for footage and a Record button. Below it, recipe cards
  (Explainer, Screen tutorial, Shorts from a long video, Podcast clips, Product
  demo, Ad) and the brand kit and look to use, pre-filled with the workspace
  defaults. "Start" creates the project, imports the footage, writes the
  brief, and opens the editor with the Director already working. This is the
  front door of the paid product: instructions start here, not inside a
  timeline.
- **Library.** Two tabs: *Recordings* (today's page) and *Projects* — cards
  with a thumbnail, recipe and brand badges, a status (Draft · In review ·
  Approved · Exported) and the number of versions.
- **Studio** — everything reused across videos:
  - **Brand kits.** Name; logo in light and dark variants; colours; fonts
    (Google Fonts or installed); lower-third defaults (name, role, style);
    intro and outro clips; watermark; caption style; tone and standing rules
    ("never show prices without a date"); default layout. Upload a logo and
    the kit proposes colours and a derived look, with contrast checked.
  - **Looks.** The built-in themes, plus custom ones: duplicate and edit
    tokens, derive from a brand kit, or derive from a reference video. Each
    look shows a preview sheet — the same scene rendered in it.
  - **Recipes.** A recipe is brief defaults (layout, platform, captions,
    export formats), the interview questions worth asking, storyboard
    patterns, QA rules and export presets. Built-in and saved-from-project.
  - **References.** Videos, images and links with notes ("the pacing", "these
    lower thirds") and tags, attachable to any project.
- **Settings.**
  - **AI services.** One list of connected services, each marked *on this
    machine* or *hosted*: speech-to-text (today in the Captions panel) and the
    language model the Director uses (Anthropic, OpenRouter, any
    OpenAI-compatible — bring your own key — or Cutline credits on Pro). The
    list is a place to *manage*, not a gate: services are still connected
    where a feature first needs them, as CLAUDE.md requires.
  - **Agents.** The MCP registration line with a copy button, token rotation,
    connected agents with when they were last seen, and permissions (may
    export, may import files, may delete clips it did not make).
  - **Usage & plan.** Credits, minutes processed, per-project cost, invoices.
- **Header.** Credits pill (Pro) beside the theme toggle; Pro badges on Pro
  items in Studio and Create.

## 4. Editor (project)

- **Top bar.** Project name, a **status pill** (Draft → In review → Approved →
  Exported), a **versions menu** ("v3 · notes pass"), and a **command bar**
  (⌘K, "Tell the director…") reachable from anywhere in the editor.
- **Left panel:** Media · Captions · **Brief**.
  - Media gains bins for *Footage*, *Brand* (imported with the kit) and
    *References* (look, don't place).
  - Brief (exists) gains a header: "From brand kit *Acme* · recipe
    *Explainer* · look *Studio Dark*", an "Update available" banner when the
    kit changed (with a diff), and **Compare looks**, which opens styleframes.
- **Right panel:** **Director** · Inspector · Scopes · History. Director is the
  first tab and opens by default on projects made through Create.
  - The thread: what the user asked, what the agent is doing.
  - The **plan**: phases with checkpoints (§5), the current one highlighted,
    and the live tool badge ("add_flow at 146 s").
  - **Questions for you**: at most five, answerable inline, each with
    "Use the default".
  - **Facts to confirm**: every number or name the agent was not sure of,
    with where it appears, the transcript line and a play button. Confirming
    one updates every clip that shows it.
  - **QA results**: what the agent fixed on its own, and what needs a decision.
  - Pause / stop, and this project's cost so far.
  - History keeps turns and lists versions.
- **Monitor.**
  - **Styleframe compare**: two or three looks side by side on the same scene;
    one click chooses.
  - **Note pins**: click the picture to leave a note at that time and place.
    It becomes a note marker on the timeline; the Director reads, fixes and
    resolves notes.
  - Safe-area guides for the platform in the brief.
- **Timeline.** A **Timeline | Storyboard** toggle. Storyboard shows scene
  cards in order — time range, layout, components, transcript excerpt,
  thumbnail. Click a card to jump there; per scene, **Regenerate** or
  **Lock**. Clips the user edited by hand are locked automatically, so the
  agent never undoes the user's work.
- **Export.** Presets from the recipe and brand kit, "every format at once"
  (16:9 and 9:16), thumbnails.

## 5. Importing workspace items into a project

1. **Through Create.** The instruction becomes the brief's goal; the recipe's
   defaults, the brand kit's fields and the chosen look are written into the
   project; the kit's logo, intro and outro are **copied** into the project's
   media (bin *Brand*); references are attached. `brief.sources` records
   `{ brandKit: {id, version}, recipe: {id, version}, look: {id, version} }`.
2. **In an open project.** Brief tab → *Apply brand kit…*, *Change look…*,
   *Use recipe…*, *Add reference…*. Each is one undo step. A new look restyles
   every role-tagged clip (`set_theme`); a brand kit sets palette and font
   overrides and adds its assets to the *Brand* bin.
3. **By the agent.** The same actions as tools — `list_brand_kits`,
   `apply_brand_kit`, `list_recipes`, `apply_recipe`, `list_references`,
   `attach_reference` — inside the agent's turn.
4. **Copies, not links.** An approved or exported video must not change when a
   kit changes. When the source has a newer version, the Brief shows
   "Kit updated · review" with a diff and an *Update* button.
5. **Assets are copied into the project's media store**, so a project stays
   self-contained: duplicate, export and missing-media detection work as
   today.
6. **And back.** *Save as look / brand kit / recipe* promotes a project's
   choices to the workspace ("Save look as *TreeFlux Dark*").

## 6. The Director pipeline

Each phase ends at a checkpoint the plan shows. A recipe can set "autopilot":
use defaults, ask only facts, stop only at the final review.

1. **Brief** — read `get_brief`; ask what is missing, at most five questions,
   each with a default.
2. **Source** — `transcribe`; `analyze_media`: face box, the source's own
   burned-in graphics and logos (the TreeFlux video had them for its first
   21.5 s), scene cuts, silences.
3. **Treatment** — a short outline and a draft storyboard.
4. **Styleframes** — one scene in two or three looks. **The one approval.**
5. **Build** — compile the storyboard (below). Tens of calls, not ~1300.
6. **Self-QA** — `lint_scene` on every scene: overlapping text, off-frame
   items, contrast, text over the face; `audio_envelope`; fix and re-render
   until clean.
7. **Facts** — list what the transcript was unsure of (TreeFlux: Level 3
   heard as "7", said 60).
8. **Review** — status *In review*; the user watches, pins notes.
9. **Notes pass** — the agent resolves each note, a new version per pass.
10. **Export** — every format the recipe asks for.

**Storyboard compiler.** The agent writes *what*; Cutline decides *how*:

```json
{
  "scenes": [
    { "id": "s3", "from": { "word": "placement tree" }, "to": { "time": 120.0 },
      "layout": "panel",
      "components": [
        { "type": "title", "text": "Two seats under every member", "at": { "word": "दो सीट" } },
        { "type": "tree", "nodes": ["You", "1st", "2nd"], "spill": "3rd", "at": { "word": "तीसरा" } }
      ] }
  ]
}
```

It compiles through the macros and the theme, keeps stable ids (so locks and
notes survive a recompile), and recompiles when the look or the storyboard
changes. That is the moat: consistent, fast, cheap, and still ordinary clips.

**Tools to add.** `analyze_media`, `lint_scene`, `get_storyboard` /
`set_storyboard` / `compile_storyboard`, `render_styleframes`, `list_facts` /
`confirm_fact`, `list_notes` / `resolve_note`, `save_version` /
`restore_version`, plus the workspace tools in §5.

**On disk.** Beside `projects/`, `recordings/`, `media/`, `exports/` under
`~/Cutline/workspaces/local/`: `brand-kits/`, `looks/`, `recipes/`,
`references/` — JSON plus copied assets, behind stores like `ProjectStore`, so
the hosting seam stays where it is.

**The Director panel's engine.** The agent loop runs in the tab and calls the
same tool executors MCP does; its model calls go through the server, which
holds the key, exactly as transcription does. MCP stays for power users who
bring their own agent.

## 7. Money

| Tier | What | Where it shows |
|---|---|---|
| Free, open source | Editor, recording, MCP, bring-your-own keys and agent, built-in looks, basic recipes | — |
| Pro (credits) | Director with Cutline credits (model + transcription), all recipes and looks, unlimited brand kits, shorts and auto-reframe, styleframes | Credits pill, Pro badges, Usage page |
| Team / Agency | A brand kit per client, approvals, review links, seats | Studio, Library statuses |
| Services (now) | Done-for-you edits through this same flow; every job becomes a recipe | — |
| Marketplace (later) | Looks and recipe packs from creators | Studio |

Credits by minutes processed follow the real cost: model and transcription
calls. Export runs in the user's browser, so there is no render bill.

## 8. Build order

1. ✅ Finish macros and fonts.
2. ✅ Storyboard compiler, and a Storyboard view — rebuild the TreeFlux
   edit from one JSON as the acceptance test.
3. ✅ Director panel and ⌘K command bar, bring-your-own key first.
4. ✅ `analyze_media`, `lint_scene`, facts cards.
5. ✅ Styleframe compare, note pins, versions, locks.
6. ✅ Studio (brand kits, looks, references), the import flows of §5, Create
   with recipes.
7. ✅ Settings (AI services, agents, usage). Pro credits need a hosted
   backend and a payment provider, which the non-goals rule out: not built.
8. Distribution: a published image on GHCR, then a single binary per OS.

## 9. How to know it works

- Time from footage to approved video.
- Edits where the user touched a clip by hand — the target is zero.
- Cost per minute of finished video.
