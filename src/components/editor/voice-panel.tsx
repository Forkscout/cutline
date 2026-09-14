/**
 * Voice: a script read aloud by the project's voice service and placed on the
 * timeline. The server makes the call with the key it holds; the audio comes
 * back as a file and is imported like any other sound, into a Voice bin.
 */

import { useEffect, useMemo, useState } from "react";
import { AudioLines, LoaderCircle, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { importFiles } from "@/editor/media";
import type { MediaAsset, Project } from "@/editor/types";
import { listVoices, serviceFor, speak, type ServiceInUse, type VoiceList } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface Remembered {
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
  onOpenServices,
  onPlace,
}: {
  project: Project;
  time: number;
  /** Opens the Services dialog, where the voice model is chosen. */
  onOpenServices: () => void;
  /** Adds a generated sound to the project, and to the timeline at `start` when given. */
  onPlace: (asset: MediaAsset, start: number | null) => void;
}) {
  const saved = useMemo(() => remembered(project.id), [project.id]);
  const [service, setService] = useState<ServiceInUse | null | undefined>(undefined);
  const [voices, setVoices] = useState<VoiceList["voices"]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voice, setVoice] = useState(saved.voice ?? "");
  const [speed, setSpeed] = useState(saved.speed ?? 1);
  const [instructions, setInstructions] = useState(saved.instructions ?? "");
  const [script, setScript] = useState("");
  const [place, setPlace] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const preferred = project.services.voice;

  useEffect(() => {
    let live = true;
    setService(undefined);
    void serviceFor("voice", preferred).then(async (found) => {
      if (!live) return;
      setService(found);
      if (!found) return;
      try {
        const list = await listVoices(found.providerId);
        if (!live) return;
        setVoices(list.voices);
        setVoicesError(null);
        setVoice((current) => (list.voices.some((v) => v.id === current) ? current : (list.voices[0]?.id ?? "")));
      } catch (err) {
        if (!live) return;
        setVoices([]);
        setVoicesError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      live = false;
    };
  }, [preferred]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(project.id), JSON.stringify({ voice, speed, instructions }));
    } catch {
      // A private window: the choices last as long as the panel.
    }
  }, [project.id, voice, speed, instructions]);

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
        const spoken = await speak(
          {
            text,
            ...(voice ? { voice } : {}),
            ...(speed !== 1 ? { speed } : {}),
            ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
            providerId: service.providerId,
            projectId: project.id,
          },
          name,
        );
        setBusy(`Importing${of}…`);
        const { assets, failed } = await importFiles([spoken.file]);
        const asset = assets[0];
        if (!asset) throw new Error(`The audio came back but could not be imported: ${failed[0]?.reason ?? "no reason given"}`);
        onPlace({ ...asset, name }, at);
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
            {service === undefined ? "Checking…" : service ? `${service.name} · ${service.model}` : "No voice service connected"}
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
            <span className="text-[10px] text-muted-foreground">Direction · for models that take it</span>
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
            Hosted voices are paid per character. The key stays on this machine; the server makes the call.
          </p>
        </>
      )}
    </div>
  );
}
