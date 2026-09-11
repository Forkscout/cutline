/**
 * Captioning one asset — from wherever the user asks: right-clicking a clip,
 * right-clicking in the media pool, or the Captions panel.
 *
 * Transcription takes seconds to minutes, so the captions are built from the
 * project as it is when the transcript arrives, not as it was at the click: a
 * caption edited in the meantime must survive. And only the stretches of the
 * timeline where this asset is heard are recaptioned; captions under other
 * clips — a second speaker's microphone, an imported interview — are kept.
 */

import { toast } from "sonner";
import type { Action } from "@/editor/project";
import { captionsForAsset } from "@/editor/transcript";
import type { Project } from "@/editor/types";
import { capabilities, transcribe } from "@/lib/ai";

export interface AutoCaptionOptions {
  /** Transcribe again even if a transcript is cached. */
  force?: boolean;
  /** ISO 639-1; omitted means the service detects it. */
  language?: string;
}

export async function runAutoCaptions(params: {
  assetId: string;
  /** The live project, read after the transcript arrives. */
  getProject: () => Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
  /** Called when no service can transcribe: show the place to connect one. */
  onNeedsSetup: () => void;
  options?: AutoCaptionOptions;
}): Promise<boolean> {
  const asset = params.getProject().assets.find((a) => a.id === params.assetId);
  if (!asset?.hasAudio) return false;

  const route = (await capabilities().catch(() => ({ transcribe: null }))).transcribe;
  if (!route) {
    params.onNeedsSetup();
    toast.info("Connect a speech-to-text service first", {
      description: "The Captions panel is open — any OpenAI-compatible transcription endpoint works.",
    });
    return false;
  }

  const where = route.local ? "on this machine" : `sent to ${route.name}`;
  const id = toast.loading(`Transcribing ${asset.name}…`, { description: where });
  try {
    const target =
      asset.origin.type === "recording"
        ? { sessionId: asset.origin.sessionId, fileName: asset.origin.fileName }
        : { mediaId: asset.id };
    const { force, language } = params.options ?? {};
    const transcript = await transcribe(
      target,
      { ...(language ? { language } : {}), ...(force ? { force } : {}) },
      (fraction, note) =>
        toast.loading(`Transcribing ${asset.name} · ${Math.round(fraction * 100)}%`, { id, description: `${note} · ${where}` }),
    );

    const project = params.getProject();
    const { cues, added } = captionsForAsset(project, asset.id, transcript);

    params.dispatch({ type: "patchAsset", assetId: asset.id, patch: { transcript } });
    // Coalesced: transcript, captions and switching them on are one undo step.
    params.dispatch({ type: "setCaptions", cues }, true);
    if (!project.captionsEnabled) params.dispatch({ type: "setProject", patch: { captionsEnabled: true } }, true);

    toast.success(`${added} captions from ${transcript.words.length} words`, {
      id,
      description:
        transcript.timing === "segment"
          ? "The service timed sentences only, so word timing is estimated."
          : `${asset.name} · ${where}`,
    });
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Transcription failed.", { id, description: undefined });
    return false;
  }
}
