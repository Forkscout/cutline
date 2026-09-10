/**
 * Realtime preview: keeps one media element per clip in step with a single
 * clock and composites them to the canvas every frame.
 *
 * The clock is `performance.now()`, not any one element's `currentTime`.
 * Elements drift — they stall on a decode, they round to frame boundaries — and
 * if the clock is one of them, every other layer chases a moving target. With
 * an independent clock each element is corrected against the same truth, and
 * only when it has drifted far enough to see.
 */

import { assetTimeFor, drawFrame } from "./compositor";
import { assetOf, fadeGainAt, projectDuration, trackAudible } from "./project";
import type { AssetUrls } from "./media";
import type { Clip, MediaAsset, Project } from "./types";

/** Correct an element only past this much drift; below it, a seek looks worse. */
const DRIFT_TOLERANCE_SEC = 0.15;

interface ClipElement {
  el: HTMLVideoElement | HTMLImageElement;
  assetId: string;
  /** Audio graph, built only for clips that carry sound. */
  gain?: GainNode;
  pan?: StereoPannerNode;
}

export class PlaybackEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private urls: AssetUrls;
  private project: Project | null = null;
  private elements = new Map<string, ClipElement>();
  private audioContext: AudioContext | null = null;

  private raf = 0;
  private renderQueued = false;
  private playing = false;
  private looping = false;
  private clockOrigin = 0;
  private timeAtOrigin = 0;
  private current = 0;
  private rate = 1;

  onTick: ((time: number, playing: boolean) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, urls: AssetUrls) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not get a 2D context for the preview.");
    this.ctx = ctx;
    this.urls = urls;
  }

  get time(): number {
    return this.current;
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  get loop(): boolean {
    return this.looping;
  }
  set loop(value: boolean) {
    this.looping = value;
  }
  /** Shuttle rate. Negative plays backwards, which is what J does. */
  get playbackRate(): number {
    return this.rate;
  }

  /** Playback bounds, honouring in/out points when the user has set them. */
  private range(project: Project): { from: number; to: number } {
    const end = projectDuration(project);
    return {
      from: project.inPoint ?? 0,
      to: project.outPoint ?? end,
    };
  }

  async setProject(project: Project): Promise<void> {
    const previous = this.project;
    this.project = project;
    if (this.canvas.width !== project.width || this.canvas.height !== project.height) {
      this.canvas.width = project.width;
      this.canvas.height = project.height;
    }

    const wanted = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        wanted.add(clip.id);
        const existing = this.elements.get(clip.id);
        if (existing && existing.assetId === clip.assetId) continue;
        const asset = assetOf(project, clip);
        // Text and shape clips draw themselves; they need no element at all.
        if (!asset || asset.offline) continue;
        existing?.el.remove();
        this.elements.set(clip.id, await this.createElement(clip, asset));
      }
    }

    for (const [clipId, entry] of this.elements) {
      if (wanted.has(clipId)) continue;
      if (entry.el instanceof HTMLVideoElement) {
        entry.el.pause();
        entry.el.src = "";
      }
      this.elements.delete(clipId);
    }

    if (previous !== project) {
      this.syncElements(this.current, false);
      this.scheduleRender();
    }
  }

  private async createElement(clip: Clip, asset: MediaAsset): Promise<ClipElement> {
    const url = await this.urls.get(asset);

    if (asset.kind === "image") {
      const img = new Image();
      img.src = url;
      img.decoding = "async";
      img.addEventListener("load", () => this.scheduleRender());
      return { el: img, assetId: clip.assetId ?? "" };
    }

    const el = document.createElement("video");
    el.src = url;
    el.preload = "auto";
    el.playsInline = true;
    // Never attached to the document: it exists to be decoded from, and a
    // detached element still decodes and still plays audio.
    el.crossOrigin = "anonymous";

    // An element is not ready the moment its src is set, and a seek does not
    // complete on the line that requests it. Without these the first paint of a
    // project lands before any frame exists and the preview stays blank.
    const repaint = () => this.scheduleRender();
    el.addEventListener("loadeddata", repaint);
    el.addEventListener("seeked", repaint);
    el.addEventListener("canplay", repaint);

    const entry: ClipElement = { el, assetId: clip.assetId ?? "" };

    if (asset.hasAudio) {
      // Routing through Web Audio is what makes fades and pan audible in the
      // preview rather than only in the export. Once an element is connected to
      // a MediaElementSource its output goes through the graph exclusively, so
      // element.volume is no longer the control — the GainNode is.
      const context = this.ensureAudioContext();
      const source = context.createMediaElementSource(el);
      const gain = context.createGain();
      const pan = context.createStereoPanner();
      source.connect(gain).connect(pan).connect(context.destination);
      entry.gain = gain;
      entry.pan = pan;
    }

    return entry;
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  private syncElements(time: number, hardSeek: boolean): void {
    if (!this.project) return;
    const active = new Set<string>();
    const anySolo = this.project.tracks.some((t) => t.solo);

    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        if (time < clip.start || time >= clip.start + clip.duration) continue;
        active.add(clip.id);

        const entry = this.elements.get(clip.id);
        if (!entry || !(entry.el instanceof HTMLVideoElement)) continue;
        const el = entry.el;

        const want = assetTimeFor(clip, time);
        if (hardSeek || Math.abs(el.currentTime - want) > DRIFT_TOLERANCE_SEC) {
          el.currentTime = Math.max(0, want);
        }

        // Reversed clips cannot be played backwards by an element, so they are
        // scrubbed frame by frame instead; playing would run the wrong way.
        const scrubOnly = clip.reversed || clip.freeze || this.rate < 0;
        el.playbackRate = Math.min(4, Math.max(0.25, Math.abs(this.rate) * clip.speed));

        const audible =
          trackAudible(this.project, track) &&
          !clip.muted &&
          !(anySolo && !track.solo);
        const gain = audible ? clip.volume * fadeGainAt(clip, time) : 0;

        if (entry.gain) {
          entry.gain.gain.value = Math.max(0, Math.min(4, gain));
          if (entry.pan) entry.pan.pan.value = Math.max(-1, Math.min(1, clip.pan));
          el.muted = false;
        } else {
          el.muted = !audible;
          el.volume = Math.max(0, Math.min(1, gain));
        }

        if (this.playing && !scrubOnly && el.paused) void el.play().catch(() => {});
        if ((!this.playing || scrubOnly) && !el.paused) el.pause();
      }
    }

    for (const [clipId, entry] of this.elements) {
      if (active.has(clipId)) continue;
      if (entry.el instanceof HTMLVideoElement && !entry.el.paused) entry.el.pause();
    }
  }

  /**
   * Coalesces repaints to one per frame. Loading a project fires `loadeddata`
   * and `seeked` on every element at once, and each would otherwise redraw the
   * whole composite.
   */
  private scheduleRender(): void {
    if (this.playing || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  /** Paint the current time. Safe to call at any moment. */
  render(): void {
    if (!this.project) return;
    drawFrame(
      this.ctx,
      this.project,
      this.current,
      (clip) => {
        const entry = this.elements.get(clip.id);
        if (!entry) return null;
        if (entry.el instanceof HTMLImageElement) {
          return entry.el.complete && entry.el.naturalWidth > 0 ? entry.el : null;
        }
        // readyState below HAVE_CURRENT_DATA means the element would draw a
        // blank frame over whatever is already correct on screen.
        return entry.el.readyState >= 2 ? entry.el : null;
      },
      { guides: true },
    );
  }

  seek(time: number): void {
    if (!this.project) return;
    const { to } = this.range(this.project);
    this.current = Math.min(Math.max(0, time), Math.max(0, to));
    this.timeAtOrigin = this.current;
    this.clockOrigin = performance.now();
    this.syncElements(this.current, true);
    this.render();
    this.scheduleRender();
    this.onTick?.(this.current, this.playing);
  }

  play(rate = 1): void {
    if (!this.project) return;
    void this.audioContext?.resume();
    const { from, to } = this.range(this.project);
    if (rate > 0 && this.current >= to - 0.01) this.current = from;
    if (rate < 0 && this.current <= from + 0.01) this.current = to;

    this.rate = rate;
    this.playing = true;
    this.timeAtOrigin = this.current;
    this.clockOrigin = performance.now();
    this.syncElements(this.current, false);
    if (this.raf === 0) this.loopFrame();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.syncElements(this.current, false);
    this.onTick?.(this.current, false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /**
   * JKL shuttle. J steps backwards through the negative rates, L forwards,
   * K stops — the transport every editor has had since tape.
   */
  shuttle(direction: -1 | 1): void {
    const steps = [1, 2, 4, 8];
    if (!this.playing) {
      this.play(direction);
      return;
    }
    const sameDirection = Math.sign(this.rate) === direction;
    if (!sameDirection) {
      this.play(direction);
      return;
    }
    const index = steps.indexOf(Math.abs(this.rate));
    const next = steps[Math.min(steps.length - 1, index + 1)] ?? 1;
    this.play((next * direction) as number as 1 | -1);
  }

  /** Move by whole frames — the unit an editor actually thinks in. */
  step(frames: number): void {
    if (!this.project) return;
    this.pause();
    this.seek(this.current + frames / this.project.frameRate);
  }

  private loopFrame = (): void => {
    if (!this.playing || !this.project) return;
    const { from, to } = this.range(this.project);
    this.current = this.timeAtOrigin + ((performance.now() - this.clockOrigin) / 1000) * this.rate;

    if (this.rate > 0 && this.current >= to) {
      if (this.looping) {
        this.current = from;
        this.timeAtOrigin = from;
        this.clockOrigin = performance.now();
        this.syncElements(this.current, true);
      } else {
        this.current = to;
        this.pause();
        this.render();
        return;
      }
    } else if (this.rate < 0 && this.current <= from) {
      this.current = from;
      this.pause();
      this.render();
      return;
    }

    this.syncElements(this.current, false);
    this.render();
    this.onTick?.(this.current, true);
    this.raf = requestAnimationFrame(this.loopFrame);
  };

  dispose(): void {
    this.pause();
    for (const entry of this.elements.values()) {
      if (entry.el instanceof HTMLVideoElement) {
        entry.el.pause();
        entry.el.src = "";
      }
    }
    this.elements.clear();
    void this.audioContext?.close();
    this.audioContext = null;
  }
}
