/**
 * Project state and every edit that can be made to it.
 *
 * All edits go through one reducer so undo can be a stack of whole documents.
 * Projects are small — plain data, a few hundred clips at worst — so keeping
 * complete snapshots costs far less than the bugs that inverse operations breed.
 */

import { sliceKeyframes } from "./keyframes";
import type { SessionMeta } from "@/recorder/types";
import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_CHROMA,
  DEFAULT_COLOR,
  DEFAULT_GUIDES,
  DEFAULT_MASK,
  DEFAULT_SHAPE,
  DEFAULT_TEXT,
  DEFAULT_TRANSFORM,
  EMPTY_BRIEF,
  NO_TRANSITION,
  type Brief,
  type CaptionCue,
  type CaptionStyle,
  type Clip,
  type ClipKind,
  type ClipRef,
  type ColorGrade,
  type EffectInstance,
  type Fact,
  type Guides,
  type ProjectServices,
  type Keyframe,
  type Marker,
  type MediaAsset,
  type Project,
  type ShapeStyle,
  type TextStyle,
  type Storyboard,
  type Theme,
  type Track,
  type TrackKind,
  type Transform,
  type Transition,
} from "./types";
import { restyleClip, themeBackground, themeCaptionStyle } from "./themes";

const id = () => crypto.randomUUID();

/** The shortest edit worth making, and the tolerance used when comparing edges. */
export const MIN_CLIP_SEC = 0.04;

/**
 * How tall a row is. 64 was one row of buttons too many: the track header
 * needed two lines for its controls, and a project with twenty-five tracks
 * showed five of them. The controls fit one line now, so a row can be the
 * height of its clips.
 */
export const TRACK_HEIGHTS = { compact: 32, normal: 44, tall: 72 } as const;
/** What every track was before that. */
export const LEGACY_TRACK_HEIGHT = 64;
const TRACK_HEIGHT: number = TRACK_HEIGHTS.normal;

/* --------------------------------------------------------------- building */

export function emptyClip(kind: ClipKind, name: string): Clip {
  return {
    id: id(),
    kind,
    name,
    start: 0,
    inPoint: 0,
    duration: 5,
    speed: 1,
    reversed: false,
    freeze: false,
    volume: 1,
    pan: 0,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    transform: structuredClone(DEFAULT_TRANSFORM),
    color: structuredClone(DEFAULT_COLOR),
    effects: [],
    mask: structuredClone(DEFAULT_MASK),
    chroma: structuredClone(DEFAULT_CHROMA),
    keyframes: [],
    transitionIn: structuredClone(NO_TRANSITION),
    transitionOut: structuredClone(NO_TRANSITION),
    linkId: null,
    enabled: true,
    label: null,
  };
}

export function mediaClip(asset: MediaAsset, start: number, transform?: Partial<Transform>): Clip {
  const clip = emptyClip("media", asset.name);
  clip.assetId = asset.id;
  clip.start = start;
  clip.duration = asset.durationSec || 5;
  if (transform) clip.transform = { ...clip.transform, ...transform };
  return clip;
}

export function textClip(start: number, duration = 4): Clip {
  const clip = emptyClip("text", "Text");
  clip.start = start;
  clip.duration = duration;
  clip.text = structuredClone(DEFAULT_TEXT);
  clip.textAnimation = "fade";
  return clip;
}

export function shapeClip(start: number, duration = 4): Clip {
  const clip = emptyClip("shape", "Shape");
  clip.start = start;
  clip.duration = duration;
  clip.shape = structuredClone(DEFAULT_SHAPE);
  return clip;
}

export function emptyTrack(kind: TrackKind, name: string): Track {
  return {
    id: id(),
    kind,
    name,
    clips: [],
    muted: false,
    solo: false,
    hidden: false,
    locked: false,
    height: TRACK_HEIGHT,
    color: null,
  };
}

export function createProject(name = "Untitled project"): Project {
  return {
    id: id(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    width: 1920,
    height: 1080,
    frameRate: 30,
    background: { type: "gradient", from: "#1e293b", to: "#0f172a", angle: 135 },
    padding: 0,
    tracks: [emptyTrack("video", "V1"), emptyTrack("audio", "A1")],
    assets: [],
    bins: [],
    markers: [],
    captions: [],
    captionStyle: structuredClone(DEFAULT_CAPTION_STYLE),
    captionsEnabled: true,
    guides: structuredClone(DEFAULT_GUIDES),
    inPoint: null,
    outPoint: null,
    brief: structuredClone(EMPTY_BRIEF),
    theme: null,
    storyboard: null,
    facts: [],
    services: {},
  };
}

/**
 * Lays a finished recording out the way it was captured: screen filling the
 * frame, camera as a picture-in-picture, audio underneath. Every track starts
 * at its recorded `offsetMs`, so the take is already in sync before the user
 * touches anything.
 */
export function projectFromSession(session: SessionMeta, assets: MediaAsset[]): Project {
  const project = createProject(session.name);
  project.assets = assets;
  project.tracks = [];

  const screen = assets.find((a) => a.sourceKind === "screen");
  const camera = assets.find((a) => a.sourceKind === "camera");
  const base = screen ?? camera;
  if (base) {
    project.width = base.width || 1920;
    project.height = base.height || 1080;
    project.frameRate = Math.round(base.frameRate) || 30;
  }
  project.padding = screen ? 0.04 : 0;

  // Everything from one take is linked. They were captured on a single clock,
  // so moving one relative to the others is a mistake until the user says
  // otherwise — and saying otherwise is what "Detach audio" is for.
  const takeLink = id();

  const startOf = (asset: MediaAsset) => {
    const track = session.tracks.find(
      (t) => asset.origin.type === "recording" && t.fileName === asset.origin.fileName.replace(".edit.", "."),
    );
    return (track?.offsetMs ?? 0) / 1000;
  };

  if (screen) {
    const track = emptyTrack("video", "Screen");
    const clip = mediaClip(screen, startOf(screen), { radius: 12, shadow: 40 });
    clip.linkId = takeLink;
    track.clips = [clip];
    project.tracks.push(track);
  }
  if (camera) {
    const track = emptyTrack("video", "Camera");
    // Only a picture-in-picture when there is a screen underneath to sit on.
    const pip = screen
      ? { x: 0.84, y: 0.8, scale: 0.26, shape: "circle" as const, shadow: 60 }
      : {};
    const clip = mediaClip(camera, startOf(camera), pip);
    clip.linkId = takeLink;
    track.clips = [clip];
    project.tracks.push(track);
  }
  for (const asset of assets) {
    if (asset.sourceKind !== "microphone" && asset.sourceKind !== "system-audio") continue;
    const track = emptyTrack("audio", asset.sourceKind === "microphone" ? "Microphone" : "System audio");
    const clip = mediaClip(asset, startOf(asset));
    clip.linkId = takeLink;
    track.clips = [clip];
    project.tracks.push(track);
  }

  if (project.tracks.length === 0) project.tracks = [emptyTrack("video", "V1"), emptyTrack("audio", "A1")];
  return project;
}

/* -------------------------------------------------------------- selectors */

export function projectDuration(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
  }
  for (const cue of project.captions) end = Math.max(end, cue.end);
  return end;
}

export function assetOf(project: Project, clip: Clip): MediaAsset | undefined {
  return clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined;
}

export function findClip(project: Project, ref: ClipRef | null): Clip | undefined {
  if (!ref) return undefined;
  return project.tracks.find((t) => t.id === ref.trackId)?.clips.find((c) => c.id === ref.clipId);
}

export function findTrack(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

/** Every clip that shares a link group with `ref`, including `ref` itself. */
export function linkedRefs(project: Project, ref: ClipRef): ClipRef[] {
  const clip = findClip(project, ref);
  if (!clip?.linkId) return [ref];
  const out: ClipRef[] = [];
  for (const track of project.tracks) {
    for (const c of track.clips) {
      if (c.linkId === clip.linkId) out.push({ trackId: track.id, clipId: c.id });
    }
  }
  return out.length > 0 ? out : [ref];
}

/** How many clips are in a clip's link group. One means it is effectively free. */
export function linkSize(project: Project, clip: Clip): number {
  if (!clip.linkId) return 1;
  let n = 0;
  for (const track of project.tracks) {
    for (const c of track.clips) if (c.linkId === clip.linkId) n += 1;
  }
  return n;
}

/** Every clip edge and marker, for snapping. */
export function snapPoints(project: Project, exclude?: string): number[] {
  const points = [0];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === exclude) continue;
      points.push(clip.start, clip.start + clip.duration);
    }
  }
  for (const marker of project.markers) points.push(marker.time);
  if (project.inPoint !== null) points.push(project.inPoint);
  if (project.outPoint !== null) points.push(project.outPoint);
  return points;
}

/** Gain from the clip's own fade handles at a given moment. */
export function fadeGainAt(clip: Clip, time: number): number {
  const local = time - clip.start;
  let gain = 1;
  if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= Math.max(0, local / clip.fadeIn);
  const fromEnd = clip.duration - local;
  if (clip.fadeOut > 0 && fromEnd < clip.fadeOut) gain *= Math.max(0, fromEnd / clip.fadeOut);
  return gain;
}

/** True when this track should be heard, accounting for any soloed track. */
export function trackAudible(project: Project, track: Track): boolean {
  if (track.muted) return false;
  const anySolo = project.tracks.some((t) => t.solo);
  return !anySolo || track.solo;
}

/* ---------------------------------------------------------------- actions */

export type Action =
  // clips
  | { type: "addClip"; trackId: string; clip: Clip }
  | { type: "moveClip"; ref: ClipRef; start: number; toTrackId?: string }
  | { type: "trimClip"; ref: ClipRef; edge: "in" | "out"; time: number; ripple?: boolean }
  | { type: "slipClip"; ref: ClipRef; delta: number }
  | { type: "splitClip"; ref: ClipRef; time: number }
  | { type: "deleteClip"; ref: ClipRef }
  | { type: "rippleDelete"; ref: ClipRef }
  | { type: "duplicateClip"; ref: ClipRef }
  | { type: "patchClip"; ref: ClipRef; patch: Partial<Clip> }
  | { type: "detachAudio"; ref: ClipRef }
  | { type: "unlinkClip"; ref: ClipRef }
  | { type: "linkClips"; refs: ClipRef[] }
  | { type: "setTransform"; ref: ClipRef; patch: Partial<Transform> }
  | { type: "setColor"; ref: ClipRef; patch: Partial<ColorGrade> }
  | { type: "setText"; ref: ClipRef; patch: Partial<TextStyle> }
  | { type: "setShape"; ref: ClipRef; patch: Partial<ShapeStyle> }
  | { type: "setMask"; ref: ClipRef; patch: Partial<Clip["mask"]> }
  | { type: "setChroma"; ref: ClipRef; patch: Partial<Clip["chroma"]> }
  | { type: "setTransition"; ref: ClipRef; edge: "in" | "out"; patch: Partial<Transition> }
  // effects
  | { type: "addEffect"; ref: ClipRef; effect: EffectInstance }
  | { type: "removeEffect"; ref: ClipRef; effectId: string }
  | { type: "patchEffect"; ref: ClipRef; effectId: string; patch: Partial<EffectInstance> }
  | { type: "reorderEffect"; ref: ClipRef; effectId: string; delta: number }
  // keyframes
  | { type: "addKeyframe"; ref: ClipRef; keyframe: Keyframe }
  | { type: "removeKeyframe"; ref: ClipRef; keyframeId: string }
  | { type: "patchKeyframe"; ref: ClipRef; keyframeId: string; patch: Partial<Keyframe> }
  // tracks
  | { type: "addTrack"; kind: TrackKind; index?: number }
  | { type: "deleteTrack"; trackId: string }
  | { type: "moveTrack"; trackId: string; delta: number }
  | { type: "patchTrack"; trackId: string; patch: Partial<Track> }
  // markers
  | { type: "addMarker"; marker: Marker }
  | { type: "patchMarker"; markerId: string; patch: Partial<Marker> }
  | { type: "deleteMarker"; markerId: string }
  // assets
  | { type: "addAssets"; assets: MediaAsset[] }
  | { type: "patchAsset"; assetId: string; patch: Partial<MediaAsset> }
  | { type: "removeAsset"; assetId: string }
  | { type: "addBin"; name: string }
  | { type: "patchBin"; binId: string; name: string }
  | { type: "deleteBin"; binId: string }
  // captions
  | { type: "setCaptions"; cues: CaptionCue[] }
  | { type: "patchCaption"; cueId: string; patch: Partial<CaptionCue> }
  | { type: "addCaption"; cue: CaptionCue }
  | { type: "deleteCaption"; cueId: string }
  | { type: "setCaptionStyle"; patch: Partial<CaptionStyle> }
  // project
  | {
      type: "setProject";
      patch: Partial<
        Pick<
          Project,
          | "name"
          | "background"
          | "padding"
          | "width"
          | "height"
          | "frameRate"
          | "captionsEnabled"
          | "inPoint"
          | "outPoint"
        >
      >;
    }
  | { type: "setGuides"; patch: Partial<Guides> }
  // direction
  | {
      type: "setBrief";
      patch: Partial<Omit<Brief, "brand" | "decisions" | "updatedAt">> & { brand?: Partial<Brief["brand"]> };
      /** One line for the decisions log. */
      decision?: string;
    }
  | { type: "setTheme"; theme: Theme; restyle: boolean }
  | { type: "setStoryboard"; storyboard: Storyboard | null }
  /** Adds or updates a fact to confirm, by id. */
  | { type: "setFact"; fact: Fact }
  /** Replaces a value everywhere it is shown — every text clip and the storyboard — and records the fact as corrected. */
  | { type: "correctFact"; id: string; from: string; to: string; note?: string }
  /** Puts the project back to a saved version; the id stays, and History keeps what it replaced. */
  | { type: "restoreVersion"; project: Project; label: string }
  /** Which connected service each role uses here; a role set to undefined goes back to the workspace's. */
  | { type: "setServices"; patch: ProjectServices };

/** Applies `fn` to every clip named in `refs`, wherever those clips live. */
function mapClips(
  project: Project,
  refs: ClipRef[],
  fn: (clip: Clip, track: Track) => Clip | Clip[],
): Project {
  const byTrack = new Map<string, Set<string>>();
  for (const ref of refs) {
    const set = byTrack.get(ref.trackId) ?? new Set<string>();
    set.add(ref.clipId);
    byTrack.set(ref.trackId, set);
  }
  return {
    ...project,
    tracks: project.tracks.map((track) => {
      const ids = byTrack.get(track.id);
      if (!ids) return track;
      return {
        ...track,
        clips: track.clips
          .flatMap((clip) => (ids.has(clip.id) ? fn(clip, track) : clip))
          .sort((a, b) => a.start - b.start),
      };
    }),
  };
}

function mapClip(project: Project, ref: ClipRef, fn: (clip: Clip) => Clip | Clip[]): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id !== ref.trackId
        ? track
        : {
            ...track,
            clips: track.clips
              .flatMap((clip) => (clip.id === ref.clipId ? fn(clip) : clip))
              .sort((a, b) => a.start - b.start),
          },
    ),
  };
}

/**
 * `from` as a whole value: correcting 7 leaves the 7 in 17, in 7,000 and in
 * 3.7 alone. The replacement is literal, so "$12" stays "$12".
 */
export function replaceValue(text: string, from: string, to: string): string {
  if (!from) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\d[.,])${escaped}(?![\\p{L}\\p{N}])(?![.,]\\d)`, "gu"), () => to);
}

/** Storyboard fields that name or anchor rather than show: a correction leaves them alone. */
const NOT_SHOWN = new Set(["id", "type", "word", "layout", "side", "icon", "tone", "style", "orientation", "scale", "highlight", "size", "node", "parent"]);

function replaceInStrings(value: unknown, swap: (text: string) => string, key = ""): unknown {
  if (typeof value === "string") return NOT_SHOWN.has(key) ? value : swap(value);
  if (Array.isArray(value)) return value.map((v) => replaceInStrings(v, swap, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceInStrings(v, swap, k)]));
  return value;
}

export function reduce(project: Project, action: Action): Project {
  const touched = (next: Project): Project => ({ ...next, updatedAt: Date.now() });

  switch (action.type) {
    /* ------------------------------------------------------------ clips */
    case "addClip":
      return touched({
        ...project,
        tracks: project.tracks.map((t) =>
          t.id === action.trackId
            ? { ...t, clips: [...t.clips, action.clip].sort((a, b) => a.start - b.start) }
            : t,
        ),
      });

    case "moveClip": {
      const source = findTrack(project, action.ref.trackId);
      const clip = findClip(project, action.ref);
      if (!source || !clip || source.locked) return project;
      const start = Math.max(0, action.start);

      if (action.toTrackId && action.toTrackId !== action.ref.trackId) {
        const target = findTrack(project, action.toTrackId);
        // Audio cannot live on a video track and vice versa: the compositor and
        // the mixer each walk one kind, so a mixed track would silently drop.
        if (!target || target.locked || target.kind !== source.kind) return project;
        const delta = start - clip.start;
        const others = linkedRefs(project, action.ref).filter((r) => r.clipId !== clip.id);
        const moved = mapClips(project, others, (c) => ({ ...c, start: Math.max(0, c.start + delta) }));
        return touched({
          ...moved,
          tracks: moved.tracks.map((t) => {
            if (t.id === source.id) return { ...t, clips: t.clips.filter((c) => c.id !== clip.id) };
            if (t.id === target.id) {
              return {
                ...t,
                clips: [...t.clips, { ...clip, start }].sort((a, b) => a.start - b.start),
              };
            }
            return t;
          }),
        });
      }
      // Linked clips shift by the same delta rather than to the same time, so a
      // take whose tracks began a few milliseconds apart keeps that offset.
      const delta = start - clip.start;
      return touched(
        mapClips(project, linkedRefs(project, action.ref), (c) => ({
          ...c,
          start: Math.max(0, c.start + delta),
        })),
      );
    }

    case "trimClip": {
      const track = findTrack(project, action.ref.trackId);
      if (track?.locked) return project;
      const clip = findClip(project, action.ref);
      if (!clip) return project;

      const group = linkedRefs(project, action.ref);

      if (action.edge === "in") {
        // Dragging the head moves the start and the source point together, so
        // the frames under the cursor stay put instead of sliding.
        const end = clip.start + clip.duration;
        const start = Math.min(Math.max(0, action.time), end - MIN_CLIP_SEC);
        const delta = start - clip.start;
        const next = mapClips(project, group, (c) => ({
          ...c,
          start: Math.max(0, c.start + delta),
          inPoint: Math.max(0, c.inPoint + delta * c.speed),
          duration: Math.max(MIN_CLIP_SEC, c.duration - delta),
          // The animation stays where it was on the timeline, as it does across a split.
          keyframes: sliceKeyframes(c.keyframes, delta),
        }));
        return touched(action.ripple ? rippleFrom(next, action.ref, -delta) : next);
      }

      const duration = Math.max(MIN_CLIP_SEC, action.time - clip.start);
      const delta = duration - clip.duration;
      const next = mapClips(project, group, (c) => ({
        ...c,
        duration: Math.max(MIN_CLIP_SEC, c.duration + delta),
      }));
      return touched(action.ripple ? rippleFrom(next, action.ref, delta) : next);
    }

    case "slipClip":
      // Slip moves the source under a fixed window: the clip keeps its place and
      // its length on the timeline, but shows different frames.
      return touched(
        mapClips(project, linkedRefs(project, action.ref), (c) => ({
          ...c,
          inPoint: Math.max(0, c.inPoint + action.delta),
        })),
      );

    case "splitClip": {
      // Both halves stay linked, but as two groups — otherwise splitting once
      // would weld all four pieces together and moving any one would drag the
      // rest of the timeline with it.
      const tailLink = id();
      return touched(
        mapClips(project, linkedRefs(project, action.ref), (clip) => {
          const at = action.time - clip.start;
          if (at <= MIN_CLIP_SEC || at >= clip.duration - MIN_CLIP_SEC) return clip;
          return [
            { ...clip, duration: at, transitionOut: structuredClone(NO_TRANSITION) },
            {
              ...structuredClone(clip),
              id: id(),
              start: clip.start + at,
              inPoint: clip.inPoint + at * clip.speed,
              duration: clip.duration - at,
              linkId: clip.linkId ? tailLink : null,
              transitionIn: structuredClone(NO_TRANSITION),
              // Clip-relative keys, re-based to the split point with the one
              // before it kept, so a held layout or a move in progress carries on.
              keyframes: sliceKeyframes(clip.keyframes, at).map((k) => ({ ...k, id: id() })),
            },
          ];
        }),
      );
    }

    case "deleteClip": {
      const group = linkedRefs(project, action.ref);
      const byTrack = new Map<string, Set<string>>();
      for (const r of group) {
        const set = byTrack.get(r.trackId) ?? new Set<string>();
        set.add(r.clipId);
        byTrack.set(r.trackId, set);
      }
      return touched({
        ...project,
        tracks: project.tracks.map((track) => {
          const ids = byTrack.get(track.id);
          if (!ids || track.locked) return track;
          return { ...track, clips: track.clips.filter((c) => !ids.has(c.id)) };
        }),
      });
    }

    case "rippleDelete": {
      const clip = findClip(project, action.ref);
      if (!clip) return project;
      const gap = clip.duration;
      const group = linkedRefs(project, action.ref);
      const byTrack = new Map<string, Set<string>>();
      for (const r of group) {
        const set = byTrack.get(r.trackId) ?? new Set<string>();
        set.add(r.clipId);
        byTrack.set(r.trackId, set);
      }
      return touched({
        ...project,
        tracks: project.tracks.map((track) => {
          const ids = byTrack.get(track.id);
          if (!ids || track.locked) return track;
          return {
            ...track,
            clips: track.clips
              .filter((c) => !ids.has(c.id))
              .map((c) => (c.start > clip.start ? { ...c, start: Math.max(0, c.start - gap) } : c)),
          };
        }),
      });
    }

    case "duplicateClip": {
      const clip = findClip(project, action.ref);
      if (!clip) return project;
      const shift = clip.duration;
      const copyLink = clip.linkId ? id() : null;
      const group = linkedRefs(project, action.ref);
      const copies = new Map<string, Clip>();

      for (const r of group) {
        const original = findClip(project, r);
        if (!original) continue;
        const copy = structuredClone(original);
        copy.id = id();
        copy.start = original.start + shift;
        copy.linkId = copyLink;
        copy.keyframes = copy.keyframes.map((k) => ({ ...k, id: id() }));
        copy.effects = copy.effects.map((e) => ({ ...e, id: id() }));
        copies.set(r.trackId, copy);
      }

      return touched({
        ...project,
        tracks: project.tracks.map((t) => {
          const copy = copies.get(t.id);
          return copy ? { ...t, clips: [...t.clips, copy].sort((a, b) => a.start - b.start) } : t;
        }),
      });
    }

    case "patchClip":
      return touched(mapClip(project, action.ref, (c) => ({ ...c, ...action.patch })));
    case "detachAudio": {
      // Pulls the sound out of the take so it can be cut on its own, which is
      // the whole point of linking by default: the break is deliberate.
      const group = linkedRefs(project, action.ref);
      const audio = group.filter((r) => findTrack(project, r.trackId)?.kind === "audio");
      if (audio.length === 0) return project;
      return touched(mapClips(project, audio, (c) => ({ ...c, linkId: null })));
    }

    case "unlinkClip": {
      const group = linkedRefs(project, action.ref);
      if (group.length < 2) return project;
      return touched(mapClips(project, group, (c) => ({ ...c, linkId: null })));
    }

    case "linkClips": {
      if (action.refs.length < 2) return project;
      const linkId = id();
      return touched(mapClips(project, action.refs, (c) => ({ ...c, linkId })));
    }

    case "setTransform":
      return touched(
        mapClip(project, action.ref, (c) => ({ ...c, transform: { ...c.transform, ...action.patch } })),
      );
    case "setColor":
      return touched(
        mapClip(project, action.ref, (c) => ({ ...c, color: { ...c.color, ...action.patch } })),
      );
    case "setText":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          text: { ...(c.text ?? DEFAULT_TEXT), ...action.patch },
        })),
      );
    case "setShape":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          shape: { ...(c.shape ?? DEFAULT_SHAPE), ...action.patch },
        })),
      );
    case "setMask":
      return touched(
        mapClip(project, action.ref, (c) => ({ ...c, mask: { ...c.mask, ...action.patch } })),
      );
    case "setChroma":
      return touched(
        mapClip(project, action.ref, (c) => ({ ...c, chroma: { ...c.chroma, ...action.patch } })),
      );
    case "setTransition":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          ...(action.edge === "in"
            ? { transitionIn: { ...c.transitionIn, ...action.patch } }
            : { transitionOut: { ...c.transitionOut, ...action.patch } }),
        })),
      );

    /* ---------------------------------------------------------- effects */
    case "addEffect":
      return touched(
        mapClip(project, action.ref, (c) => ({ ...c, effects: [...c.effects, action.effect] })),
      );
    case "removeEffect":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          effects: c.effects.filter((e) => e.id !== action.effectId),
        })),
      );
    case "patchEffect":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          effects: c.effects.map((e) =>
            e.id === action.effectId
              ? { ...e, ...action.patch, params: { ...e.params, ...(action.patch.params ?? {}) } }
              : e,
          ),
        })),
      );
    case "reorderEffect":
      return touched(
        mapClip(project, action.ref, (c) => {
          const index = c.effects.findIndex((e) => e.id === action.effectId);
          const target = index + action.delta;
          if (index < 0 || target < 0 || target >= c.effects.length) return c;
          const effects = [...c.effects];
          const [moved] = effects.splice(index, 1);
          if (moved) effects.splice(target, 0, moved);
          return { ...c, effects };
        }),
      );

    /* -------------------------------------------------------- keyframes */
    case "addKeyframe":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          // Re-keying the same property at the same instant replaces rather
          // than stacks, which is what clicking the stopwatch twice should do.
          keyframes: [
            ...c.keyframes.filter(
              (k) =>
                !(
                  k.property === action.keyframe.property &&
                  Math.abs(k.time - action.keyframe.time) < 1e-3
                ),
            ),
            action.keyframe,
          ],
        })),
      );
    case "removeKeyframe":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          keyframes: c.keyframes.filter((k) => k.id !== action.keyframeId),
        })),
      );
    case "patchKeyframe":
      return touched(
        mapClip(project, action.ref, (c) => ({
          ...c,
          keyframes: c.keyframes.map((k) =>
            k.id === action.keyframeId ? { ...k, ...action.patch } : k,
          ),
        })),
      );

    /* ----------------------------------------------------------- tracks */
    case "addTrack": {
      const count = project.tracks.filter((t) => t.kind === action.kind).length + 1;
      const track = emptyTrack(action.kind, `${action.kind === "video" ? "V" : "A"}${count}`);
      const tracks = [...project.tracks];
      tracks.splice(action.index ?? tracks.length, 0, track);
      return touched({ ...project, tracks });
    }
    case "deleteTrack":
      return touched({ ...project, tracks: project.tracks.filter((t) => t.id !== action.trackId) });
    case "moveTrack": {
      const index = project.tracks.findIndex((t) => t.id === action.trackId);
      const target = index + action.delta;
      if (index < 0 || target < 0 || target >= project.tracks.length) return project;
      const tracks = [...project.tracks];
      const [moved] = tracks.splice(index, 1);
      if (moved) tracks.splice(target, 0, moved);
      return touched({ ...project, tracks });
    }
    case "patchTrack":
      return touched({
        ...project,
        tracks: project.tracks.map((t) => (t.id === action.trackId ? { ...t, ...action.patch } : t)),
      });

    /* ---------------------------------------------------------- markers */
    case "addMarker":
      return touched({ ...project, markers: [...project.markers, action.marker].sort((a, b) => a.time - b.time) });
    case "patchMarker":
      return touched({
        ...project,
        markers: project.markers.map((m) => (m.id === action.markerId ? { ...m, ...action.patch } : m)),
      });
    case "deleteMarker":
      return touched({ ...project, markers: project.markers.filter((m) => m.id !== action.markerId) });

    /* ----------------------------------------------------------- assets */
    case "addAssets":
      return touched({ ...project, assets: [...project.assets, ...action.assets] });
    case "patchAsset":
      return touched({
        ...project,
        assets: project.assets.map((a) => (a.id === action.assetId ? { ...a, ...action.patch } : a)),
      });
    case "removeAsset":
      return touched({
        ...project,
        assets: project.assets.filter((a) => a.id !== action.assetId),
        // A clip pointing at a removed asset would render nothing and be
        // impossible to fix from the UI, so it goes with it.
        tracks: project.tracks.map((t) => ({
          ...t,
          clips: t.clips.filter((c) => c.assetId !== action.assetId),
        })),
      });
    case "addBin":
      return touched({ ...project, bins: [...project.bins, { id: id(), name: action.name, parentId: null }] });
    case "patchBin":
      return touched({
        ...project,
        bins: project.bins.map((b) => (b.id === action.binId ? { ...b, name: action.name } : b)),
      });
    case "deleteBin":
      return touched({
        ...project,
        bins: project.bins.filter((b) => b.id !== action.binId),
        assets: project.assets.map((a) => (a.binId === action.binId ? { ...a, binId: null } : a)),
      });

    /* --------------------------------------------------------- captions */
    case "setCaptions":
      return touched({ ...project, captions: [...action.cues].sort((a, b) => a.start - b.start) });
    case "addCaption":
      return touched({ ...project, captions: [...project.captions, action.cue].sort((a, b) => a.start - b.start) });
    case "patchCaption":
      return touched({
        ...project,
        captions: project.captions
          .map((c) => (c.id === action.cueId ? { ...c, ...action.patch } : c))
          .sort((a, b) => a.start - b.start),
      });
    case "deleteCaption":
      return touched({ ...project, captions: project.captions.filter((c) => c.id !== action.cueId) });
    case "setCaptionStyle":
      return touched({ ...project, captionStyle: { ...project.captionStyle, ...action.patch } });

    /* ---------------------------------------------------------- project */
    case "setProject":
      return touched({ ...project, ...action.patch });
    case "setGuides":
      return touched({ ...project, guides: { ...project.guides, ...action.patch } });

    /* -------------------------------------------------------- direction */
    case "setBrief": {
      const brief = project.brief ?? EMPTY_BRIEF;
      const { brand, ...rest } = action.patch;
      return touched({
        ...project,
        brief: {
          ...brief,
          ...rest,
          brand: { ...brief.brand, ...brand },
          decisions: action.decision ? [...brief.decisions, { at: Date.now(), text: action.decision }] : brief.decisions,
          updatedAt: Date.now(),
        },
      });
    }
    case "setStoryboard":
      return touched({ ...project, storyboard: action.storyboard });
    case "restoreVersion":
      return touched({ ...action.project, id: project.id });
    case "setServices": {
      const services = { ...project.services };
      for (const [role, id] of Object.entries(action.patch)) {
        if (id) services[role as keyof ProjectServices] = id;
        else delete services[role as keyof ProjectServices];
      }
      return touched({ ...project, services });
    }
    case "setFact": {
      const exists = project.facts.some((f) => f.id === action.fact.id);
      return touched({
        ...project,
        facts: exists ? project.facts.map((f) => (f.id === action.fact.id ? action.fact : f)) : [...project.facts, action.fact],
      });
    }
    case "correctFact": {
      const swap = (text: string) => replaceValue(text, action.from, action.to);
      const tracks = project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.text && swap(clip.text.content) !== clip.text.content
            ? { ...clip, name: swap(clip.name), text: { ...clip.text, content: swap(clip.text.content) } }
            : clip,
        ),
      }));
      // The storyboard too, or the next compile would put the old value back.
      const storyboard = project.storyboard ? (replaceInStrings(project.storyboard, swap) as Storyboard) : null;
      const previous = project.facts.find((f) => f.id === action.id);
      const note = action.note ?? previous?.note;
      const fact: Fact = {
        source: previous?.source ?? "agent",
        ...(previous?.time !== undefined ? { time: previous.time } : {}),
        id: action.id,
        value: action.to,
        was: action.from,
        status: "corrected",
        ...(note ? { note } : {}),
      };
      const facts = previous ? project.facts.map((f) => (f.id === action.id ? fact : f)) : [...project.facts, fact];
      return touched({ ...project, tracks, storyboard, facts });
    }
    case "setTheme": {
      const theme = action.theme;
      if (!action.restyle) return touched({ ...project, theme });
      return touched({
        ...project,
        theme,
        background: themeBackground(theme),
        captionStyle: { ...project.captionStyle, ...themeCaptionStyle(theme) },
        tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => restyleClip(c, theme)) })),
      });
    }
  }
}

/** Shifts every later clip on the same track by `delta`, for ripple trims. */
function rippleFrom(project: Project, ref: ClipRef, delta: number): Project {
  if (delta === 0) return project;
  const clip = findClip(project, ref);
  if (!clip) return project;
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id !== ref.trackId
        ? track
        : {
            ...track,
            clips: track.clips
              .map((c) => (c.id !== ref.clipId && c.start > clip.start ? { ...c, start: Math.max(0, c.start + delta) } : c))
              .sort((a, b) => a.start - b.start),
          },
    ),
  };
}

/* ------------------------------------------------------------------- undo */

export interface HistoryEntry {
  project: Project;
  label: string;
}

export interface History {
  present: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  label: string;
}

/** Deeper than this and the memory is not worth the regret it buys back. */
const HISTORY_LIMIT = 200;

export function newHistory(project: Project): History {
  return { present: project, past: [], future: [], label: "Open project" };
}

const ACTION_LABELS: Partial<Record<Action["type"], string>> = {
  moveClip: "Move clip",
  trimClip: "Trim clip",
  slipClip: "Slip clip",
  splitClip: "Split clip",
  deleteClip: "Delete clip",
  rippleDelete: "Ripple delete",
  duplicateClip: "Duplicate clip",
  detachAudio: "Detach audio",
  unlinkClip: "Unlink clips",
  linkClips: "Link clips",
  setTransform: "Transform",
  setColor: "Colour",
  setText: "Edit text",
  addEffect: "Add effect",
  removeEffect: "Remove effect",
  addKeyframe: "Add keyframe",
  addTrack: "Add track",
  deleteTrack: "Delete track",
  addMarker: "Add marker",
  addAssets: "Import media",
  setCaptions: "Set captions",
};

/**
 * `label` names the history entry instead of the action's default — how an
 * agent turn shows up as "Agent: tighten the intro" rather than "Split clip".
 */
export function apply(history: History, action: Action, coalesce = false, label?: string): History {
  const next = reduce(history.present, action);
  if (next === history.present) return history;
  const entryLabel = label ?? ACTION_LABELS[action.type] ?? "Edit";
  // Dragging emits an action per pointer move; without coalescing, one drag
  // would take fifty presses of undo to walk back.
  const past = coalesce
    ? history.past
    : [...history.past, { project: history.present, label: history.label }].slice(-HISTORY_LIMIT);
  return { present: next, past, future: [], label: entryLabel };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    present: previous.project,
    past: history.past.slice(0, -1),
    future: [{ project: history.present, label: history.label }, ...history.future],
    label: previous.label,
  };
}

export function redo(history: History): History {
  const next = history.future[0];
  if (!next) return history;
  return {
    present: next.project,
    past: [...history.past, { project: history.present, label: history.label }],
    future: history.future.slice(1),
    label: next.label,
  };
}

/** Jump to any point in history — what a History panel needs. */
export function jumpTo(history: History, index: number): History {
  const all = [...history.past, { project: history.present, label: history.label }, ...history.future];
  const target = all[index];
  if (!target) return history;
  return {
    present: target.project,
    past: all.slice(0, index),
    future: all.slice(index + 1),
    label: target.label,
  };
}
