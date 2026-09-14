/**
 * Voice: a script read aloud by the project's voice service and placed on the
 * timeline. A speaker is a saved profile — the voice, a pinned model, speed and
 * the direction sent with every line — so each line sounds like the last, and
 * every generated sound keeps a record of how it was read.
 */

import { useEffect, useMemo, useState } from "react";
import { AudioLines, LoaderCircle, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { importFiles } from "@/editor/media";
import type { Action } from "@/editor/project";
import type { GeneratedAudio, MediaAsset, Project, VoiceProfile } from "@/editor/types";
import { listVoices, serviceFor, speak, type ServiceInUse, type VoiceList } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface Remembered {
  profileId?: string;
  voice?: string;
  speed?: number;
  instructions?: string;
}

const storageKey = (projectId: string) => `cutline:voice:${projectId}`;

function remembered(projectId: string): Remembered {
  try {
    return JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

export function VoicePanel({
  project,
  time,
  dispatch,
  onOpenServices,
  onPlace,
}: {
  project: Project;
  time: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
  /** Opens the Services dialog, where the voice model is chosen. */
  onOpenServices: () => void;
  /** Adds a generated sound to the project, and to the timeline at `start` when given. */
  onPlace: (asset: MediaAsset, start: number | null) => void;
}) {
  const saved = useMemo(() => remembered(project.id), [project.id]);
  const [profileId, setProfileId] = useState(saved.profileId ?? "");
  const profile = project.voices.find((v) => v.id === profileId);
  const [service, setService] = useState<ServiceInUse | null | undefined>(undefined);
  const [voices, setVoices] = useState<VoiceList["voices"]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voice, setVoice] = useState(saved.voice ?? "");
  const [speed, setSpeed] = useState(saved.speed ?? 1);
  const [instructions, setInstructions] = useState(saved.instructions ?? "");
  const [script, setScript] = useState("");
  const [place, setPlace] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const preferred = project.services.voice;
  // A speaker reads with the model it was saved with, whatever the service's default is now.
  const model = profile?.model ?? service?.model;
  const providerId = profile?.providerId ?? service?.providerId;

  useEffect(() => {
    let live = true;
    setService(undefined);
    void serviceFor("voice", preferred).then((found) => {
      if (live) setService(found);
    });
    return () => {
      live = false;
    };
  }, [preferred]);

  useEffect(() => {
    if (!providerId || !model) return;
    let live = true;
    void listVoices(providerId, model)
      .then((list) => {
        if (!live) return;
        setVoices(list.voices);
        setVoicesError(null);
        setVoice((current) => (list.voices.some((v) => v.id === current) ? current : (list.voices[0]?.id ?? "")));
      })
      .catch((err: unknown) => {
        if (!live) return;
        setVoices([]);
        setVoicesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [providerId, model]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(project.id), JSON.stringify({ profileId, voice, speed, instructions }));
    } catch {
      // A private window: the choices last as long as the panel.
    }
  }, [project.id, profileId, voice, speed, instructions]);

  const choose = (id: string) => {
    setProfileId(id);
    const chosen = project.voices.find((v) => v.id === id);
    if (!chosen) return;
    setVoice(chosen.voice);
    setSpeed(chosen.speed ?? 1);
    setInstructions(chosen.instructions ?? "");
  };

  const differs = Boolean(profile && (profile.voice !== voice || (profile.speed ?? 1) !== speed || (profile.instructions ?? "") !== instructions.trim()));

  const saveProfile = (base: VoiceProfile | undefined, name: string) => {
    if (!model || !voice || !name.trim()) return;
    const now = Date.now();
    const next: VoiceProfile = {
      id: base?.id ?? crypto.randomUUID(),
      name: name.trim(),
      ...(providerId ? { providerId } : {}),
      model,
      voice,
      ...(speed !== 1 ? { speed } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      ...(base?.language ? { language: base.language } : {}),
      ...(base?.notes ? { notes: base.notes } : {}),
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
    };
    dispatch({ type: "setVoiceProfile", profile: next });
    setProfileId(next.id);
    setNaming(null);
    toast.success(base ? `${next.name} updated` : `${next.name} saved`, {
      description: base ? "New lines use these settings; lines already read keep theirs." : "Every line read as this speaker uses these settings.",
    });
  };

  // A blank line starts a new clip: a paragraph each is easier to time and to redo.
  const paragraphs = script
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const generate = async () => {
    if (!service) return;
    let at = place ? time : null;
    let made = 0;
    try {
      for (const [i, text] of paragraphs.entries()) {
        const of = paragraphs.length > 1 ? ` ${i + 1} of ${paragraphs.length}` : "";
        setBusy(`Speaking${of}…`);
        const name = text.replace(/\s+/g, " ").slice(0, 40);
        const direction = instructions.trim();
        const spoken = await speak(
          {
            text,
            ...(voice ? { voice } : {}),
            ...(speed !== 1 ? { speed } : {}),
            ...(direction ? { instructions: direction } : {}),
            ...(model ? { model } : {}),
            ...(providerId ? { providerId } : {}),
            projectId: project.id,
          },
          name,
        );
        setBusy(`Importing${of}…`);
        const { assets, failed } = await importFiles([spoken.file]);
        const asset = assets[0];
        if (!asset) throw new Error(`The audio came back but could not be imported: ${failed[0]?.reason ?? "no reason given"}`);
        const generated: GeneratedAudio = {
          kind: "voice",
          text,
          ...(profile ? { profileId: profile.id, speaker: profile.name } : {}),
          providerId: spoken.providerId,
          service: spoken.provider,
          model: spoken.model,
          voice: spoken.voice,
          ...(speed !== 1 ? { speed } : {}),
          ...(direction ? { instructions: direction } : {}),
          createdAt: Date.now(),
          by: "user",
        };
        onPlace({ ...asset, name, generated }, at);
        if (at !== null) at += asset.durationSec + 0.3;
        made += 1;
      }
      toast.success(made === 1 ? "Voice added" : `${made} voice clips added`, {
        description: place ? `On an audio track from ${time.toFixed(1)} s, and in the Voice bin.` : "In the Voice bin.",
      });
      setScript("");
    } catch (err) {
      toast.error(made ? `Stopped after ${made} of ${paragraphs.length}` : "Could not generate the voice", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto px-2 pb-2">
      <div className="flex items-center gap-2 rounded-lg border p-2">
        <AudioLines className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium">Voice</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {service === undefined ? "Checking…" : service ? `${service.name} · ${model ?? service.model}` : "No voice service connected"}
          </div>
        </div>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onOpenServices}>
          <Settings2 className="size-3" />
          Services
        </Button>
      </div>

      {service === null ? (
        <p className="px-1 text-[11px] leading-snug text-muted-foreground">
          Give a connected service a voice model in Services — on OpenRouter, google/gemini-3.1-flash-tts-preview reads Hindi and English — and a script
          written here is read aloud and put on the timeline.
        </p>
      ) : (
        <>
          <div className="space-y-1">
            <span className="flex items-center text-[10px] text-muted-foreground">
              Speaker
              {naming === null && (
                <button className="ml-auto hover:text-foreground" disabled={!voice} onClick={() => setNaming("")}>
                  {profile ? "Save as a new speaker…" : "Save as a speaker…"}
                </button>
              )}
            </span>
            <select className="h-7 w-full rounded-md border bg-transparent px-1 text-[11px]" value={profile ? profileId : ""} onChange={(e) => choose(e.target.value)}>
              <option value="">No saved speaker</option>
              {project.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.voice}
                </option>
              ))}
            </select>
            {naming !== null && (
              <div className="flex gap-1">
                <Input
                  autoFocus
                  className="h-7 text-[11px]"
                  placeholder="Narrator"
                  value={naming}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveProfile(undefined, naming);
                    if (e.key === "Escape") setNaming(null);
                  }}
                />
                <Button size="sm" className="h-7 px-2 text-[11px]" disabled={!naming.trim()} onClick={() => saveProfile(undefined, naming)}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setNaming(null)}>
                  Cancel
                </Button>
              </div>
            )}
            {profile && differs && (
              <p className="text-[10px] leading-snug text-muted-foreground">
                These settings differ from {profile.name}'s, so lines read now will not match the others.{" "}
                <button className="text-primary hover:underline" onClick={() => saveProfile(profile, profile.name)}>
                  Save them to {profile.name}
                </button>{" "}
                or{" "}
                <button className="text-primary hover:underline" onClick={() => choose(profile.id)}>
                  put {profile.name}'s back
                </button>
                .
              </p>
            )}
          </div>

          <label className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Voice</span>
            <select
              className="h-7 w-full rounded-md border bg-transparent px-1 text-[11px]"
              value={voice}
              disabled={voices.length === 0}
              onChange={(e) => setVoice(e.target.value)}
            >
              {voices.length === 0 && <option value="">{voicesError ? "Could not list voices" : "Loading voices…"}</option>}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            {voicesError && <span className="block text-[10px] leading-snug text-destructive">{voicesError}</span>}
          </label>

          <label className="space-y-1">
            <span className="flex text-[10px] text-muted-foreground">
              Script
              <span className="ml-auto tabular-nums">
                {script.trim().length} characters{paragraphs.length > 1 ? ` · ${paragraphs.length} clips` : ""}
              </span>
            </span>
            <Textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={7}
              className="text-xs"
              placeholder="What the voice should say. A blank line starts a new clip."
            />
          </label>

          <label className="space-y-1">
            <span className="text-[10px] text-muted-foreground">Direction · sent with every line, for models that take it</span>
            <Input
              className="h-7 text-[11px]"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Warm and unhurried, like explaining to a friend"
            />
          </label>

          <div className="space-y-1">
            <span className="flex text-[10px] text-muted-foreground">
              Speed
              <span className="ml-auto tabular-nums">{speed.toFixed(2)}×</span>
            </span>
            <Slider value={[speed]} min={0.5} max={2} step={0.05} onValueChange={([v]) => setSpeed(v ?? 1)} />
          </div>

          <label className="flex items-center gap-2 text-[11px]">
            <Switch checked={place} onCheckedChange={setPlace} />
            Place at the playhead · {time.toFixed(1)} s
          </label>

          <Button size="sm" className="h-8 text-xs" disabled={!service || paragraphs.length === 0 || busy !== null} onClick={() => void generate()}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <AudioLines className="size-3.5" />}
            {busy ?? (paragraphs.length > 1 ? `Generate ${paragraphs.length} clips` : "Generate voice")}
          </Button>
          <p className="text-[10px] leading-snug text-muted-foreground">
            Each clip keeps how it was read — speaker, voice, model, direction and script — in the Inspector. Hosted voices are paid per character.
          </p>
        </>
      )}
    </div>
  );
}
