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

export const SERVER_INSTRUCTIONS = `Cutline is a video editor open in the user's browser. These tools edit the project open there; the user watches every change land and can undo it.

Working rules:
1. Start with get_editor_state. "Here" and "this" mean the playhead and the selection.
2. Call start_turn with the user's instruction before editing, so the whole change is one undo step.
3. Ids come from get_project. Times are seconds on the timeline; positions are 0..1 of the frame.
4. Prefer text and shape clips with keyframes for titles and motion — they stay editable.
5. Verify before you report. After visual edits, render_frame or contact_sheet across the range you touched; after audio or timing edits, audio_envelope. Report what you saw, including anything wrong. Never call a change done from the JSON alone.
6. export_video only once the checks above look right; give the user the path it returns.`;

/* ------------------------------------------------ server <-> tab protocol */

export type BridgeContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Server to tab, over the /api/bridge WebSocket. */
export type ToTab = { type: "call"; id: string; tool: string; args: unknown };

/** Tab to server. */
export type FromTab =
  /** pageId is one per page load, so the server can drop a stale second socket from it. */
  | { type: "hello"; pageId: string; projectId: string; name: string; where?: string }
  | { type: "focus" }
  | { type: "result"; id: string; ok: true; content: BridgeContent[] }
  | { type: "result"; id: string; ok: false; error: string };
