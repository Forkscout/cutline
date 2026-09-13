/**
 * What an agent can do to a project, as MCP tools.
 *
 * `ACTION_TOOLS` has exactly one entry per reducer `Action` variant, keyed by
 * the action's type — `agent-bridge.ts` fails the typecheck if a variant is
 * missing, so the agent can never fall behind what the interface can do. Each
 * is its own typed, described tool rather than one generic `apply`, because
 * models choose far better from specific tools with specific descriptions.
 *
 * The server reads this file to list and validate tools; the editor tab reads
 * it to execute them. No DOM and no "@/" imports.
 */

import { z } from "zod";
import * as s from "./agent-schemas";
import { EFFECTS } from "./effects";
import { THEME_IDS } from "./themes";

export type Shape = Record<string, z.ZodType>;

export interface ToolSpec<S extends Shape = Shape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** True for tools that only look. */
  readOnly?: boolean;
}

export type ArgsOf<T extends ToolSpec> = z.output<z.ZodObject<T["input"]>>;

const tool = <S extends Shape>(spec: ToolSpec<S>) => spec;

const EFFECT_PARAMS = EFFECTS.map(
  (e) => `${e.type} (${e.params.map((p) => `${p.key} ${p.min}..${p.max}, default ${p.default}`).join("; ")})`,
).join(", ");

/* --------------------------------------------------------------- actions */

export const ACTION_TOOLS = {
  addClip: tool({
    name: "add_clip",
    title: "Add clip",
    description:
      "Places a new clip on a track. kind 'media' needs an assetId from get_project and goes on a video track if the asset has video, an audio track if it is sound only. 'text' and 'shape' are native layers that stay editable and cost nothing to render — prefer them for titles, lower thirds and callouts. Returns the new clip's id.",
    input: {
      trackId: s.trackId,
      kind: z.enum(["media", "text", "shape"]),
      start: s.seconds("Where the clip begins on the timeline"),
      assetId: z.string().optional().describe("Media clips only"),
      duration: z.number().positive().optional().describe("Seconds; media defaults to the asset's length, text and shape to 4"),
      name: z.string().optional(),
      text: s.textPatch.optional().describe("Text clips: content and style"),
      shape: s.shapePatch.optional().describe("Shape clips: kind and colours"),
      transform: s.transformPatch.optional(),
    },
  }),
  moveClip: tool({
    name: "move_clip",
    title: "Move clip",
    description: "Moves a clip to a new start time, optionally onto another track of the same kind. Clips recorded together move together by the same amount.",
    input: { ...s.clipRef, start: s.seconds("New start"), toTrackId: z.string().optional() },
  }),
  trimClip: tool({
    name: "trim_clip",
    title: "Trim clip",
    description: "Moves one edge of a clip to a timeline time. edge 'in' trims the head (the source advances with it), 'out' the tail. ripple closes or opens the gap by shifting later clips on the track.",
    input: { ...s.clipRef, edge: z.enum(["in", "out"]), time: s.seconds("Timeline time for that edge"), ripple: z.boolean().optional() },
  }),
  slipClip: tool({
    name: "slip_clip",
    title: "Slip clip",
    description: "Shifts which part of the source a clip shows without moving it on the timeline.",
    input: { ...s.clipRef, delta: z.number().describe("Seconds of source to shift by; negative is earlier") },
  }),
  splitClip: tool({
    name: "split_clip",
    title: "Split clip",
    description: "Cuts a clip in two at a timeline time. Linked partners (the same take's camera, screen and mic) are cut at the same instant. Returns the ids of the new halves.",
    input: { ...s.clipRef, time: s.seconds("Timeline time of the cut") },
  }),
  deleteClip: tool({
    name: "delete_clip",
    title: "Delete clip",
    description: "Removes a clip and its linked partners, leaving a gap. The media file is untouched.",
    input: s.clipRef,
  }),
  rippleDelete: tool({
    name: "ripple_delete_clip",
    title: "Ripple delete",
    description: "Removes a clip and closes the gap by pulling later clips earlier.",
    input: s.clipRef,
  }),
  duplicateClip: tool({
    name: "duplicate_clip",
    title: "Duplicate clip",
    description: "Copies a clip and places the copy straight after it.",
    input: s.clipRef,
  }),
  patchClip: tool({
    name: "set_clip_properties",
    title: "Set clip properties",
    description: "Sets speed, direction, freeze, volume, pan, mute, fades, enabled, label or text animation. Use move_clip and trim_clip for timing.",
    input: { ...s.clipRef, patch: s.clipPatch },
  }),
  detachAudio: tool({
    name: "detach_audio",
    title: "Detach audio",
    description: "Frees a take's sound from its pictures so it can be edited on its own. The pictures stay linked to each other.",
    input: s.clipRef,
  }),
  unlinkClip: tool({
    name: "unlink_clip",
    title: "Unlink clip",
    description: "Removes one clip from its linked group.",
    input: s.clipRef,
  }),
  linkClips: tool({
    name: "link_clips",
    title: "Link clips",
    description: "Links clips so they move, trim, split and delete as one.",
    input: { clips: z.array(z.object(s.clipRef)).min(2) },
  }),
  setTransform: tool({
    name: "set_transform",
    title: "Set transform",
    description: "Position, scale, rotation, opacity, crop, rounding, shape, shadow and blend mode of a visual clip. Positions are 0..1 of the frame, so they survive resolution changes.",
    input: { ...s.clipRef, patch: s.transformPatch },
  }),
  setColor: tool({
    name: "set_color_grade",
    title: "Set colour grade",
    description: "Colour correction on a clip. Every field is 0 when neutral.",
    input: { ...s.clipRef, patch: s.colorPatch },
  }),
  setText: tool({
    name: "set_text",
    title: "Set text",
    description: "Content and style of a text clip.",
    input: { ...s.clipRef, patch: s.textPatch },
  }),
  setShape: tool({
    name: "set_shape",
    title: "Set shape",
    description: "Kind and colours of a shape clip.",
    input: { ...s.clipRef, patch: s.shapePatch },
  }),
  setMask: tool({
    name: "set_mask",
    title: "Set mask",
    description: "A rectangular or elliptical mask on a clip.",
    input: { ...s.clipRef, patch: s.maskPatch },
  }),
  setChroma: tool({
    name: "set_chroma_key",
    title: "Set chroma key",
    description: "Keys out a colour (a green screen) from a media clip.",
    input: { ...s.clipRef, patch: s.chromaPatch },
  }),
  setTransition: tool({
    name: "set_transition",
    title: "Set transition",
    description: "The transition at a clip's head ('in') or tail ('out').",
    input: { ...s.clipRef, edge: z.enum(["in", "out"]), patch: s.transitionPatch },
  }),
  addEffect: tool({
    name: "add_effect",
    title: "Add effect",
    description: `Adds an effect to a clip. Types and parameters: ${EFFECT_PARAMS}. Returns the effect id.`,
    input: { ...s.clipRef, effectType: s.effectType, params: z.record(z.string(), z.number()).optional() },
  }),
  removeEffect: tool({
    name: "remove_effect",
    title: "Remove effect",
    description: "Removes one effect from a clip.",
    input: { ...s.clipRef, effectId: s.id("Effect id") },
  }),
  patchEffect: tool({
    name: "set_effect",
    title: "Set effect",
    description: "Changes an effect's parameters or switches it on or off.",
    input: {
      ...s.clipRef,
      effectId: s.id("Effect id"),
      enabled: z.boolean().optional(),
      params: z.record(z.string(), z.number()).optional(),
    },
  }),
  reorderEffect: tool({
    name: "reorder_effect",
    title: "Reorder effect",
    description: "Moves an effect earlier (negative) or later (positive) in the clip's chain.",
    input: { ...s.clipRef, effectId: s.id("Effect id"), delta: z.number().int() },
  }),
  addKeyframe: tool({
    name: "add_keyframe",
    title: "Add keyframe",
    description: "Animates a numeric property. property is a dot path into the clip, e.g. transform.x, transform.scale, transform.opacity, transform.rotation, color.exposure, volume. time is seconds from the clip's own start, so moving the clip does not re-time it. Returns the keyframe id.",
    input: {
      ...s.clipRef,
      property: z.string().min(1),
      time: s.seconds("From the clip's start"),
      value: z.number(),
      easing: s.easing.optional(),
    },
  }),
  removeKeyframe: tool({
    name: "remove_keyframe",
    title: "Remove keyframe",
    description: "Removes one keyframe.",
    input: { ...s.clipRef, keyframeId: s.id("Keyframe id") },
  }),
  patchKeyframe: tool({
    name: "set_keyframe",
    title: "Set keyframe",
    description: "Changes a keyframe's time, value or easing.",
    input: {
      ...s.clipRef,
      keyframeId: s.id("Keyframe id"),
      time: z.number().min(0).optional(),
      value: z.number().optional(),
      easing: s.easing.optional(),
    },
  }),
  addTrack: tool({
    name: "add_track",
    title: "Add track",
    description: "Adds an empty video or audio track. Later video tracks draw on top.",
    input: { kind: z.enum(["video", "audio"]), index: z.number().int().min(0).optional() },
  }),
  deleteTrack: tool({
    name: "delete_track",
    title: "Delete track",
    description: "Removes a track and every clip on it.",
    input: { trackId: s.trackId },
  }),
  moveTrack: tool({
    name: "move_track",
    title: "Move track",
    description: "Moves a track up or down in the stack.",
    input: { trackId: s.trackId, delta: z.number().int() },
  }),
  patchTrack: tool({
    name: "set_track",
    title: "Set track",
    description: "Name, mute, solo, hide, lock, height or colour of a track.",
    input: { trackId: s.trackId, patch: s.trackPatch },
  }),
  addMarker: tool({
    name: "add_marker",
    title: "Add marker",
    description: "Drops a marker on the timeline — useful for leaving the user a note at a moment. Returns its id.",
    input: s.markerPatch.required({ time: true }).shape,
  }),
  patchMarker: tool({
    name: "set_marker",
    title: "Set marker",
    description: "Changes a marker.",
    input: { markerId: s.id("Marker id"), patch: s.markerPatch },
  }),
  deleteMarker: tool({
    name: "delete_marker",
    title: "Delete marker",
    description: "Removes a marker.",
    input: { markerId: s.id("Marker id") },
  }),
  addAssets: tool({
    name: "import_recording",
    title: "Import recording",
    description: "Adds every track of a finished recording (ids from list_recordings) to the project's media, remuxed and with thumbnails and waveforms. Place them with add_clip afterwards.",
    input: { sessionId: s.id("Recording id from list_recordings") },
  }),
  patchAsset: tool({
    name: "set_asset",
    title: "Set asset",
    description: "Renames, tags, rates or files a media item. Never touches the file itself.",
    input: { assetId: s.id("Asset id"), patch: s.assetPatch },
  }),
  removeAsset: tool({
    name: "remove_asset",
    title: "Remove asset",
    description: "Removes a media item from this project, and its clips from the timeline. The file on disk is kept.",
    input: { assetId: s.id("Asset id") },
  }),
  addBin: tool({
    name: "add_bin",
    title: "Add bin",
    description: "Creates a folder in the media pool.",
    input: { name: z.string().min(1) },
  }),
  patchBin: tool({
    name: "rename_bin",
    title: "Rename bin",
    description: "Renames a media-pool folder.",
    input: { binId: s.id("Bin id"), name: z.string().min(1) },
  }),
  deleteBin: tool({
    name: "delete_bin",
    title: "Delete bin",
    description: "Removes a media-pool folder; its items move to the top level.",
    input: { binId: s.id("Bin id") },
  }),
  setCaptions: tool({
    name: "set_captions",
    title: "Replace captions",
    description: "Replaces every caption cue at once.",
    input: { cues: z.array(s.captionCue) },
  }),
  patchCaption: tool({
    name: "set_caption",
    title: "Set caption",
    description: "Changes one caption cue's timing or text.",
    input: { cueId: s.id("Cue id"), patch: s.captionCue.partial() },
  }),
  addCaption: tool({
    name: "add_caption",
    title: "Add caption",
    description: "Adds one caption cue. Returns its id.",
    input: s.captionCue.shape,
  }),
  deleteCaption: tool({
    name: "delete_caption",
    title: "Delete caption",
    description: "Removes one caption cue.",
    input: { cueId: s.id("Cue id") },
  }),
  setCaptionStyle: tool({
    name: "set_caption_style",
    title: "Set caption style",
    description: "How burned-in captions look.",
    input: { patch: s.captionStylePatch },
  }),
  setProject: tool({
    name: "set_project",
    title: "Set project",
    description: "Name, background, padding, resolution, frame rate, caption visibility, or the in/out range.",
    input: { patch: s.projectPatch },
  }),
  setGuides: tool({
    name: "set_guides",
    title: "Set guides",
    description: "Preview guides and snapping. Never affects the export.",
    input: { patch: s.guidesPatch },
  }),
  setBrief: tool({
    name: "set_brief",
    title: "Set brief",
    description:
      "Records what the video is for and how it should feel — goal, audience, platform, tone, layout, on-screen language, captions, brand, references, standing rules — in the project, where every later agent reads it with get_brief. Pass only what changed. decision appends one line to the decisions log: what was decided, and why.",
    input: { patch: s.briefPatch.optional(), decision: z.string().min(1).max(400).optional() },
  }),
  setStoryboard: tool({
    name: "set_storyboard",
    title: "Set storyboard",
    description:
      "Writes the whole storyboard: scenes in order, each with a layout (panel, full, pip, backdrop) and components (title, points, chips, stat, statement, flow, cards, split, bars, tally, tree, lower_third) anchored to the words they land on. Nothing is drawn until compile_storyboard. Anchors: { word } is the first time that phrase is said after the previous anchor — copy it from the transcript tool, in the transcript's own spelling; { time } is a timeline time. guide('storyboard') has the format and a worked scene.",
    input: { storyboard: s.storyboard },
  }),
  setFact: tool({
    name: "set_fact",
    title: "Set fact",
    description:
      "Records a number or name on screen that needs the client's word: flag one you are unsure of (status open, with a note saying why — \"the transcript heard 7\"), or record their answer (confirmed, or dismissed when it is not a fact). Matches an existing fact by id or value. To change the value everywhere it is shown, use correct_fact. list_facts shows what needs confirming.",
    input: {
      id: z.string().optional(),
      value: z.string().min(1).max(80).describe("As it appears on screen: 21,000 or Level 7"),
      status: s.factStatus.optional(),
      note: z.string().max(300).optional(),
      time: z.number().min(0).optional(),
    },
  }),
  correctFact: tool({
    name: "correct_fact",
    title: "Correct fact",
    description:
      "Replaces a value everywhere it is shown — every text clip, and the storyboard so a recompile keeps it — and records it as corrected. Whole values only: correcting 7 leaves 17 and 7,000 alone. Use it once the client has given the right value.",
    input: {
      value: z.string().min(1).max(80).describe("As it is on screen now"),
      to: z.string().min(1).max(80),
      note: z.string().max(300).optional(),
    },
  }),
  restoreVersion: tool({
    name: "restore_version",
    title: "Restore version",
    description:
      "Puts the project back to a saved version (list_versions). What it replaces stays in History, so one undo brings it back — save_version first if it deserves a name.",
    input: { versionId: z.string().min(1) },
  }),
  setServices: tool({
    name: "set_services",
    title: "Set services",
    description:
      "Chooses which connected service this project uses for a role: transcribe (captions and the transcript), chat (the Director's model), voice, image, video. null puts a role back to the workspace's default — the service connected last that can do it. list_services shows what is connected.",
    input: {
      transcribe: z.string().nullable().optional(),
      chat: z.string().nullable().optional(),
      voice: z.string().nullable().optional(),
      image: z.string().nullable().optional(),
      video: z.string().nullable().optional(),
    },
  }),
  cutRange: tool({
    name: "cut_range",
    title: "Cut range",
    description:
      "Removes a stretch of time from the whole edit and closes the gap: on every track, clips inside it go, a clip across a boundary is split with its source and animation continuous, and everything after moves left by the removed length — markers, in/out, captions, facts and storyboard time anchors too. One undo step. snap: \"words\" moves a boundary that lands inside a word to the middle of the nearest pause — use it, or cut_words, whenever speech is involved. Refused if a locked track would be left behind. Afterwards read transcript across the join and render_frame it.",
    input: {
      from: z.number().min(0).describe("Start of the stretch to remove, timeline seconds"),
      to: z.number().min(0).describe("End of the stretch to remove, timeline seconds"),
      snap: z.enum(["words"]).optional(),
    },
  }),
  setTheme: tool({
    name: "set_theme",
    title: "Set theme",
    description: `Chooses the design theme — palette, fonts, type scale, shapes, motion, how the speaker's panel sits — that every add_* macro styles itself from. themeId picks a built-in theme (${THEME_IDS.join(", ")}; list_themes describes them, preview_themes shows them on a frame); overrides adjusts tokens on top of it, or on top of the current theme when themeId is omitted. restyle (default true) also restyles every clip a macro made, the background and the captions — so a finished edit changes its look in one call.`,
    input: {
      lookId: z.string().optional().describe("A look saved in the Studio — list_themes marks them — instead of themeId"), themeId: s.themeId.optional(), overrides: s.themePatch.optional(), restyle: z.boolean().optional() },
  }),
} as const;

export type ActionToolKey = keyof typeof ACTION_TOOLS;

/* ------------------------------------------------ looking, and the turn */

export const EDITOR_TOOLS = {
  getEditorState: tool({
    name: "get_editor_state",
    title: "Editor state",
    readOnly: true,
    description: "Which project is open, its length, where the playhead is and what is selected. When the user says 'here' or 'this', they mean the playhead and the selection — call this first.",
    input: {},
  }),
  getStoryboard: tool({
    name: "get_storyboard",
    title: "Get storyboard",
    readOnly: true,
    description: "The project's storyboard, with the time each scene resolves to (or why it does not), and when it was last compiled.",
    input: {},
  }),
  setScene: tool({
    name: "set_scene",
    title: "Set scene",
    description: "Adds one scene to the storyboard, or replaces the scene with the same id — to change a scene without rewriting the rest. Place a new one after an existing scene with after; default the end. Lock a scene by setting locked. Then compile_storyboard({ only: [id] }).",
    input: { scene: s.storyScene, after: z.string().optional().describe("Id of the scene it follows") },
  }),
  compileStoryboard: tool({
    name: "compile_storyboard",
    title: "Compile storyboard",
    description:
      "Turns the storyboard into clips through the macros and the theme: resolves every anchor, removes what earlier compiles made for these scenes (never clips the user edited by hand, never locked scenes), rebuilds the speaker's layout moves from the whole storyboard, and builds each component. Nothing changes if a scene's times cannot be resolved; the report says why. only compiles just those scenes.",
    input: { only: z.array(z.string()).optional().describe("Scene ids; default every scene not locked") },
  }),
  getBrief: tool({
    name: "get_brief",
    title: "Get brief",
    readOnly: true,
    description:
      "The project's brief — goal, audience, platform, tone, layout, language, captions, brand, references, rules, decisions log — and its design theme, with the questions still unanswered. Read it at the start of every session: it is what the client and earlier agents already settled. If questions remain, ask the client before building (guide('brief')).",
    input: {},
  }),
  getProject: tool({
    name: "get_project",
    title: "Get project",
    readOnly: true,
    description: "The open project as JSON: tracks, clips (with ids), assets, markers, captions. Thumbnails and waveform peaks are left out unless full is true.",
    input: { full: z.boolean().optional() },
  }),
  renderFrame: tool({
    name: "render_frame",
    title: "Render frame",
    readOnly: true,
    description: "Draws the frame at a timeline time exactly as the export will, and returns it as an image. Look after every visual edit — the JSON saying a layer is there does not mean it is visible, in frame, or legible.",
    input: {
      time: s.seconds("Timeline time"),
      width: z.number().int().min(64).max(1920).optional().describe("Pixels; default 960"),
      format: z.enum(["jpeg", "png"]).optional(),
    },
  }),
  contactSheet: tool({
    name: "contact_sheet",
    title: "Contact sheet",
    readOnly: true,
    description: "A grid of frames sampled evenly across a range, each labelled with its time. One frame at one guessed time proves almost nothing; use this to check the whole range an edit touched before reporting it done.",
    input: {
      start: s.seconds("Range start"),
      end: s.seconds("Range end"),
      count: z.number().int().min(2).max(24).optional().describe("Frames; default 9"),
    },
  }),
  audioEnvelope: tool({
    name: "audio_envelope",
    title: "Audio envelope",
    readOnly: true,
    description: "Loudness of the mix across a range, with silent stretches and clipped peaks listed. No image shows a gap in the narration — check this after any edit to audio or timing.",
    input: {
      start: s.seconds("Range start"),
      end: s.seconds("Range end"),
      buckets: z.number().int().min(4).max(400).optional().describe("Default 60"),
    },
  }),
  transcribe: tool({
    name: "transcribe",
    title: "Transcribe",
    description:
      "Transcribes an asset's speech through the speech-to-text service the user connected — on this machine or hosted — and stores the word-timed transcript on the asset; read it with transcript. Long audio can outlast one call: while it runs this answers status 'running' with progress, and calling it again with the same assetId keeps waiting on the same job. A transcript already made is reused unless force is true. captions: true also rebuilds the captions where this asset is heard.",
    input: {
      assetId: z.string().min(1).describe("Asset id, from get_project"),
      language: z.string().regex(/^[a-z]{2,3}$/).optional().describe("ISO 639 code, e.g. hi or en; omitted, the service detects it"),
      force: z.boolean().optional().describe("Transcribe again even if a transcript exists"),
      captions: z.boolean().optional().describe("Also rebuild the captions from it"),
    },
  }),
  transcript: tool({
    name: "transcript",
    title: "Transcript",
    readOnly: true,
    description:
      "What is said on the timeline, word by word, each with its timeline time — from the transcripts stored on the assets (made by transcribe, or by the user's Generate captions). Use it to find a moment by what was said, to cut on a word, to time a title or an animation to a word, or to check captions against speech.",
    input: {
      start: z.number().min(0).optional().describe("Range start, seconds; default the beginning"),
      end: z.number().min(0).optional().describe("Range end, seconds; default the end"),
    },
  }),
  layoutMove: tool({
    name: "layout_move",
    title: "Layout move",
    description:
      "Moves the speaker's clip between full frame, a side panel (a rounded card theme.layout.panelWidth wide, cropped around the subject) and picture-in-picture, with keyframes over the theme's move time. Graphics macros then use the space beside the panel. Start the move ~0.3 s before the sentence it serves; never return to full frame for less than ~3 s.",
    input: {
      at: s.seconds("When the move starts"),
      to: z.enum(["panel", "full", "pip"]),
      side: z.enum(["right", "left"]).optional().describe("Default right"),
      subjectX: z.number().min(0).max(1).optional().describe("Where the subject sits across the source, 0..1 (analyze_media finds it); default the last panel's, else the middle"),
      duration: z.number().min(0.1).max(3).optional().describe("Seconds; default the theme's"),
      trackId: z.string().optional().describe("With clipId, the clip to move; default the speaker at that time"),
      clipId: z.string().optional(),
    },
  }),
  addTitle: tool({
    name: "add_title",
    title: "Add title",
    description:
      "A kicker (the section, 2–4 words), a title wrapped to the space, an optional subtitle and an optional footer line, styled from the theme. Placed beside the speaker's panel when there is one, under anything the scene already shows. Returns the clips and `bottom`, where the next element can go.",
    input: {
      start: s.seconds("When it arrives"),
      end: s.seconds("When the scene ends"),
      kicker: z.string().max(60).optional(),
      title: z.string().min(1).max(160),
      subtitle: z.string().max(240).optional(),
      footer: z.string().max(80).optional(),
      y: z.number().min(0).optional().describe("Top edge, px at 1080p; default under what is already there"),
    },
  }),
  addPoints: tool({
    name: "add_points",
    title: "Add points",
    description: "A list, one row per item, each arriving at its own time (the word it belongs to), with a check, a cross, a dot or a number before it.",
    input: {
      end: s.seconds("When the scene ends"),
      items: z
        .array(
          z.object({
            at: s.seconds("When it arrives"),
            text: z.string().min(1),
            icon: z.enum(["check", "cross", "dot", "number", "none"]).optional(),
            lead: z.string().max(30).optional().describe("A bold accent word before the text, e.g. 'Level 4'"),
          }),
        )
        .min(1)
        .max(10),
      y: z.number().min(0).optional(),
      size: z.number().min(12).max(80).optional().describe("px at 1080p; default the theme's body size"),
    },
  }),
  addChips: tool({
    name: "add_chips",
    title: "Add chips",
    description: "Pills in a row — tags, options, a rhythm like Cash · Hold · Cash — measured in the theme's face and wrapped to the space. tone: accent (default), positive, neutral.",
    input: {
      end: s.seconds("When the scene ends"),
      items: z
        .array(z.object({ at: s.seconds("When it arrives"), text: z.string().min(1).max(40), tone: z.enum(["accent", "positive", "neutral"]).optional() }))
        .min(1)
        .max(12),
      y: z.number().min(0).optional(),
      size: z.number().min(12).max(80).optional(),
    },
  }),
  addStat: tool({
    name: "add_stat",
    title: "Add stat",
    description: "One striking number or short value, large, with what it means beside or below it.",
    input: {
      start: s.seconds("When it arrives"),
      end: s.seconds("When the scene ends"),
      value: z.string().min(1).max(16),
      label: z.string().max(120).optional(),
      y: z.number().min(0).optional(),
    },
  }),
  addFlow: tool({
    name: "add_flow",
    title: "Add flow",
    description: "Two to five boxes left to right with arrows between — a sequence, a cause and effect — each arriving on its word; the last highlighted unless highlight is none.",
    input: {
      end: s.seconds("When the scene ends"),
      steps: z
        .array(z.object({ at: s.seconds("When it arrives — the word it belongs to"), text: z.string().min(1), style: z.enum(["box", "pill"]).optional().describe("pill: an amount or a token between boxes") }))
        .min(2)
        .max(5),
      y: z.number().min(0).optional(),
      highlight: z.enum(["last", "none"]).optional(),
    },
  }),
  addBars: tool({
    name: "add_bars",
    title: "Add bars",
    description:
      "Bars that grow on their words: horizontal with labels (a comparison) or vertical (a ladder). scale log for values spanning orders of magnitude; display is the text shown for a value (\"1,26,000\").",
    input: {
      end: s.seconds("When the scene ends"),
      items: z
        .array(z.object({ at: s.seconds("When it arrives"), label: z.string().min(1).max(30), value: z.number(), display: z.string().max(20).optional() }))
        .min(2)
        .max(12),
      orientation: z.enum(["horizontal", "vertical"]).optional(),
      scale: z.enum(["linear", "log"]).optional(),
      highlight: z.enum(["last", "max", "none"]).optional(),
      y: z.number().min(0).optional(),
      height: z.number().min(120).max(700).optional().describe("Vertical bars: the tallest, px at 1080p; default 420"),
    },
  }),
  addLowerThird: tool({
    name: "add_lower_third",
    title: "Add lower third",
    description: "A name and a role on a plate at the bottom of the graphics' space — for introducing a speaker or a place.",
    input: { start: s.seconds("When it arrives"), end: s.seconds("When it leaves"), name: z.string().min(1).max(60), role: z.string().max(80).optional() },
  }),
  addStatement: tool({
    name: "add_statement",
    title: "Add statement",
    description: "A few words, very large — a term being named ('Spillover'), a sum ('6 × 100 USDT' / '= 600 USDT'), a verdict. One to four lines, each arriving on its word; tone accent for the one that matters.",
    input: {
      end: s.seconds("When the scene ends"),
      lines: z.array(z.object({ at: s.seconds("When it arrives"), text: z.string().min(1).max(80), tone: z.enum(["text", "accent", "muted"]).optional() })).min(1).max(4),
      size: z.enum(["hero", "stat", "title"]).optional().describe("hero (default) is between a title and a stat"),
      y: z.number().min(0).optional(),
    },
  }),
  addTally: tool({
    name: "add_tally",
    title: "Add tally",
    description: "Rows of dots showing a count — 'Row 1 ●● 2 seats', 'Row 2 ●●●● 4 seats' — with the number in a column beside them.",
    input: {
      end: s.seconds("When the scene ends"),
      items: z.array(z.object({ at: s.seconds("When it arrives"), label: z.string().min(1).max(30), count: z.number().int().min(0).max(999), value: z.string().max(30) })).min(1).max(6),
      y: z.number().min(0).optional(),
    },
  }),
  addCards: tool({
    name: "add_cards",
    title: "Add cards",
    description: "Two to four cards side by side, each with an optional kicker, a title and a line of body — the halves of a system, options, a comparison.",
    input: {
      end: s.seconds("When the scene ends"),
      cards: z.array(z.object({ at: s.seconds("When it arrives"), kicker: z.string().max(40).optional(), title: z.string().min(1).max(80), body: z.string().max(200).optional() })).min(1).max(4),
      highlight: z.enum(["last", "first", "none"]).optional(),
      y: z.number().min(0).optional(),
    },
  }),
  addSplit: tool({
    name: "add_split",
    title: "Add split",
    description: "One thing dividing into two or three — a payment split in half — a box with connectors down to cards.",
    input: {
      end: s.seconds("When the scene ends"),
      source: z.object({ at: s.seconds("When it arrives"), text: z.string().min(1).max(60) }),
      branches: z.array(z.object({ at: s.seconds("When it arrives"), title: z.string().min(1).max(60), body: z.string().max(200).optional() })).min(2).max(3),
      y: z.number().min(0).optional(),
    },
  }),
  addTree: tool({
    name: "add_tree",
    title: "Add tree",
    description:
      "A tree of nodes drawn level by level, each arriving on its word — a referral matrix, the seats under a member. A node with no parent is a root, or arrives unattached; a move carries a node to a new parent at a time (a spill to the first empty seat).",
    input: {
      end: s.seconds("When the scene ends"),
      nodes: z
        .array(z.object({ id: z.string().min(1).max(30), label: z.string().min(1).max(12), parent: z.string().nullable().optional(), at: s.seconds("When it arrives"), tone: z.enum(["accent", "positive", "neutral"]).optional(), note: z.string().max(40).optional() }))
        .min(1)
        .max(15),
      moves: z.array(z.object({ node: z.string(), parent: z.string(), at: s.seconds("When it arrives") })).max(5).optional(),
      y: z.number().min(0).optional(),
      size: z.number().min(40).max(160).optional().describe("Node diameter, px at 1080p; default 96"),
    },
  }),
  addBackdrop: tool({
    name: "add_backdrop",
    title: "Add backdrop",
    description: "A plate over the whole frame in the theme's background, for graphics that cut away from a full-frame speaker (b-roll layout). Add it before the graphics of that stretch.",
    input: { start: s.seconds("When it arrives"), end: s.seconds("When it leaves"), opacity: z.number().min(0).max(1).optional().describe("Default the theme's scrim, 0.78") },
  }),
  previewThemes: tool({
    name: "preview_themes",
    title: "Preview themes",
    readOnly: true,
    description:
      "One frame of the edit drawn in several themes side by side, labelled — how the client chooses a look from a picture. Only clips the macros made restyle, so build one scene with them first and preview a time inside it. Changes nothing; choose with set_theme.",
    input: {
      time: s.seconds("A frame with the scene you built"),
      themes: z.array(s.themeId).min(1).max(6).optional().describe("Default all six"),
      width: z.number().int().min(240).max(960).optional().describe("Each cell, px; default 480"),
    },
  }),
  themeFromMedia: tool({
    name: "theme_from_media",
    title: "Theme from media",
    readOnly: true,
    description:
      "Reads the colours of a logo or a reference (an image asset, or a video asset at a time) and proposes theme overrides: its strongest colour as the accent, adjusted until it reads on the base theme's background. Returns the palette, the overrides and the contrast; apply with set_theme({ themeId: base, overrides }).",
    input: {
      assetId: z.string().min(1).describe("From get_project; import the logo or reference first"),
      time: z.number().min(0).optional().describe("Video assets: the frame to read, seconds into the file; default 1"),
      base: s.themeId.optional().describe("The theme to bring the brand into; default the project's"),
    },
  }),
  analyzeMedia: tool({
    name: "analyze_media",
    title: "Analyze media",
    readOnly: true,
    description:
      "What is in a video before you decide how to cut it: graphics already burned into it (keep those stretches full frame, or a panel's crop slices them), where the subject sits across the frame (layout_move's subjectX), shot cuts, and silences. Decodes small frames across the whole file; a long file can answer 'running' — call again with the same assetId.",
    input: { assetId: z.string().min(1).describe("From get_project") },
  }),
  askClient: tool({
    name: "ask_client",
    title: "Ask the client",
    description:
      "Opens a form in the client's editor with your questions and returns their answers. Give each question a suggested answer they can accept, options when there are a few sensible ones, and why you ask. If they have not answered within ~90 s it answers 'waiting' — call again with the same questions to keep waiting. 'declined' means they closed it: ask in chat, or go with your suggestions and say so. Record what you learn with set_brief.",
    input: {
      title: z.string().max(80).optional(),
      questions: z
        .array(
          z.object({
            question: z.string().min(3).max(200),
            options: z.array(z.string().min(1).max(60)).max(8).optional(),
            multiple: z.boolean().optional().describe("Several options may be chosen"),
            suggested: z.string().max(200).optional().describe("The default you would pick"),
            why: z.string().max(200).optional(),
          }),
        )
        .min(1)
        .max(8),
    },
  }),
  lintScene: tool({
    name: "lint_scene",
    title: "Lint scene",
    readOnly: true,
    description:
      "Checks the graphics in a scene, a range or the whole timeline as the export will draw them: text overlapping text or running off its card, anything off-frame or outside title-safe, text below WCAG contrast against what is really behind it (measured on rendered frames), text over the speaker, and text on screen too briefly to read. Each issue names its clips — with scene and component, for compiled ones — and a fix. Run it on every scene after building, fix, and run it again until it is clean.",
    input: {
      scene: z.string().optional().describe("A storyboard scene id; default the whole timeline"),
      from: z.number().min(0).optional(),
      to: z.number().min(0).optional(),
      contrast: z.boolean().optional().describe("Measure contrast on rendered frames (default true; slower)"),
    },
  }),
  listFacts: tool({
    name: "list_facts",
    title: "List facts",
    readOnly: true,
    description:
      "Every number on screen, checked against what was said around it, and every fact recorded: which need the client's word (flagged open, or not heard nearby as digits or a number word), where each is shown and what the transcript heard there. Ask the client about those (ask_client), then set_fact({ value, status: \"confirmed\" }) or correct_fact({ value, to }). Report any left unconfirmed.",
    input: {},
  }),
  saveVersion: tool({
    name: "save_version",
    title: "Save version",
    description:
      "Saves the project as it is now under a name — \"v2 · notes pass\" — so it can be compared or restored later. Save one before a big change and after each round of notes.",
    input: { label: z.string().min(1).max(80) },
  }),
  listVersions: tool({
    name: "list_versions",
    title: "List versions",
    readOnly: true,
    description: "The project's saved versions, newest first: id, label and when. restore_version puts one back.",
    input: {},
  }),
  listNotes: tool({
    name: "list_notes",
    title: "List notes",
    readOnly: true,
    description:
      "The client's notes: each marker with a note — when it is, where it is pinned in the picture, and what is under the pin at that moment (clip, text, scene and component) — and whether it has been resolved. Fix each, then resolve_note with what you did. Leave a note for the client with add_marker({ time, note, pin, author: \"agent\" }).",
    input: { all: z.boolean().optional().describe("Include resolved notes") },
  }),
  resolveNote: tool({
    name: "resolve_note",
    title: "Resolve note",
    description:
      "Marks a note dealt with and records what you did, in a sentence the client will read beside it. Resolve only what you changed; answer a question without resolving it.",
    input: { id: z.string(), reply: z.string().min(1).max(500) },
  }),
  listBrandKits: tool({
    name: "list_brand_kits",
    title: "List brand kits",
    readOnly: true,
    description: "Brand kits kept in the Studio: name, colours, fonts, tone, rules, default layout, and the files kept with each (logo, intro, outro). apply_brand_kit brings one into this project.",
    input: {},
  }),
  applyBrandKit: tool({
    name: "apply_brand_kit",
    title: "Apply brand kit",
    description:
      "Brings a brand kit into this project as a copy: its colours and faces into the theme (the accent kept readable) with every graphic made from the theme restyled, its logo, intro and outro copied into the media's Brand bin, and its name, rules, tone and layout into the brief. The brief records which version was used.",
    input: { id: z.string() },
  }),
  listRecipes: tool({
    name: "list_recipes",
    title: "List recipes",
    readOnly: true,
    description:
      "Recipes, built in and saved in the Studio, for kinds of video — explainer, screen tutorial, shorts, podcast clips, product demo, ad: brief defaults, the questions worth asking, how the storyboard usually goes, checks before export, and delivery formats.",
    input: {},
  }),
  applyRecipe: tool({
    name: "apply_recipe",
    title: "Apply recipe",
    description: "Fills the brief's gaps from a recipe — never over what the client said — adds its rules, and records it. Then ask its questions and follow its patterns.",
    input: { id: z.string() },
  }),
  listReferences: tool({
    name: "list_references",
    title: "List references",
    readOnly: true,
    description: "References kept in the Studio — videos, images and links — each with what to take from it and its tags.",
    input: { tag: z.string().optional() },
  }),
  attachReference: tool({
    name: "attach_reference",
    title: "Attach reference",
    description: "Attaches a Studio reference to this brief. Its file, if it has one, is copied into the media's References bin, for contact_sheet to look at — not to be placed on the timeline.",
    input: { id: z.string(), note: z.string().max(300).optional() },
  }),
  listServices: tool({
    name: "list_services",
    title: "List services",
    readOnly: true,
    description:
      "The AI services connected on this machine — what each can do, and with which model — and which one this project uses for each role. Keys never appear here. set_services chooses one for this project; voice, image and video are written down for later, as nothing in Cutline generates them yet.",
    input: {},
  }),
  cutRanges: tool({
    name: "cut_ranges",
    title: "Cut ranges",
    description:
      "Several cuts at once, as one undo step — a tightening pass. Give ranges in the timeline as it is now; they are applied from the last to the first, so no range shifts another, and overlapping ranges merge. snap: \"words\" as in cut_range. Answers with what was cut and any warnings.",
    input: {
      ranges: z.array(z.object({ from: z.number().min(0), to: z.number().min(0) })).min(1).max(200),
      snap: z.enum(["words"]).optional(),
    },
  }),
  cutWords: tool({
    name: "cut_words",
    title: "Cut words",
    description:
      "Removes speech by its words: from the first word of the `from` phrase to the last word of the `to` phrase, the first time each is said after `after` seconds. The cut runs from the middle of the pause before to the middle of the pause after, so the join keeps a natural pause and no word is clipped. Copy phrases from transcript, in its spelling. Answers with the words removed and the sentence as it now reads across the join.",
    input: {
      from: z.string().min(1).describe("The first words to remove"),
      to: z.string().min(1).describe("The last words to remove; the same as from for a single phrase"),
      after: z.number().min(0).optional(),
    },
  }),
  startTurn: tool({
    name: "start_turn",
    title: "Start turn",
    description: "Call once at the start of each request, with the user's instruction. Every edit until the next start_turn becomes one undo step named after it, so the user can take the whole change back with one press.",
    input: { instruction: z.string().min(1).max(200) },
  }),
  exportVideo: tool({
    name: "export_video",
    title: "Export video",
    description:
      "Renders the timeline to a new video file through the same pipeline as the Export button, saves it under ~/Cutline, and returns its path. Never overwrites an earlier export. It is the slow step — check the whole range with contact_sheet and audio_envelope first.",
    input: {
      container: z.enum(["mp4", "webm"]).optional().describe("Default mp4"),
      height: z.number().int().min(144).max(2160).optional().describe("Output height in pixels; default the project's"),
      useInOut: z.boolean().optional().describe("Only the range between the project's in and out points"),
    },
  }),
  undo: tool({
    name: "undo",
    title: "Undo",
    description: "Steps back one history entry. During a turn that is the whole turn so far.",
    input: {},
  }),
} as const;

export type EditorToolKey = keyof typeof EDITOR_TOOLS;

/** Everything the tab executes, by MCP name. */
export const TAB_TOOLS: Record<string, { key: string; spec: ToolSpec; kind: "action" | "editor" }> =
  Object.fromEntries([
    ...Object.entries(ACTION_TOOLS).map(([key, spec]) => [spec.name, { key, spec, kind: "action" as const }]),
    ...Object.entries(EDITOR_TOOLS).map(([key, spec]) => [spec.name, { key, spec, kind: "editor" as const }]),
  ]);

export const SERVER_INSTRUCTIONS = `Cutline is a video editor open in the user's browser. These tools edit the project open there, live; the user watches and can undo. Work like a director, not a button-presser.

1. Start with get_editor_state, then get_brief. New here? guide() lists the playbook; read guide('workflow').
2. If the brief has unanswered questions, ask the client (ask_client shows a form in their editor, or ask in chat) and record answers with set_brief. Do not build on guesses about layout, brand or tone.
3. Look at the source before deciding: analyze_media, transcribe then transcript, contact_sheet.
4. Propose a treatment in a few lines and show the look with preview_themes. Build one scene as a styleframe and get a yes before the full build.
5. Call start_turn with the instruction before editing, so the whole change is one undo step. Write the edit as a storyboard — set_storyboard, get_storyboard, compile_storyboard; guide('storyboard') — rather than hundreds of calls: scenes anchored to the words, compiled the same way every time, changed one scene at a time with set_scene. The macros (layout_move, add_title, add_points, add_chips, add_stat, add_flow, add_bars, add_lower_third) are the same vocabulary for one-off additions; raw tools remain for anything custom.
6. Verify before you report: lint_scene on what you built, fixing until it is clean; render_frame or contact_sheet across everything you touched; audio_envelope after timing edits. list_facts shows numbers on screen nobody said: ask the client, record answers with set_fact or correct_fact, and report any still unconfirmed.
7. export_video only once the checks look right; give the user the path it returns.
8. When the client leaves notes, list_notes, fix each, resolve_note with what you did, and save_version after the pass — \"v3 · notes pass\".

Ids come from get_project. Times are seconds on the timeline; positions are 0..1 of the frame; sizes are pixels at 1080p.`;

/* ------------------------------------------------ server <-> tab protocol */

export type BridgeContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Server to tab, over the /api/bridge WebSocket. */
export type ToTab =
  /**
   * `turn` is the instruction of the project's current turn, as the server last
   * relayed start_turn: a page that was reloaded has lost it, and an editor the
   * hold moved to never saw it. Absent after a server restart, when the tab's
   * own copy stands.
   */
  | { type: "call"; id: string; tool: string; args: unknown; turn?: string }
  /** Whether this editor holds its project — the one that saves — and how many have it open. */
  | { type: "lock"; holder: boolean; editors: number };

/** Tab to server. */
export type FromTab =
  /** pageId is one per page load, so the server can drop a stale second socket from it. */
  /**
   * touchedAt is when the page was loaded or last focused, so a reconnect
   * does not count as the user choosing this editor.
   */
  | { type: "hello"; pageId: string; projectId: string; name: string; where?: string; wasHolder?: boolean; touchedAt?: number }
  /** The user asked for this editor to be the one that saves. */
  | { type: "takeover" }
  | { type: "focus" }
  | { type: "result"; id: string; ok: true; content: BridgeContent[] }
  | { type: "result"; id: string; ok: false; error: string };
