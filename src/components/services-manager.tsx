/**
 * The services Cutline talks to, in one place: what is connected, what each
 * can do, and — inside a project — which one fills each role here.
 *
 * One component serves Settings and the editor's Services dialog, so there is
 * one form to learn and one to keep right. Keys go to the server and never
 * come back; a project stores an id, never a key and never a URL.
 */

import { useEffect, useState } from "react";
import { Check, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { Action } from "@/editor/project";
import type { Project, ProjectServices } from "@/editor/types";
import {
  ROLES,
  SERVICE_ROLES,
  canDo,
  capabilities,
  listProviders,
  modelOf,
  probeProvider,
  removeProvider,
  saveProvider,
  type Capabilities,
  type ProviderKind,
  type ProviderReport,
  type ServiceRole,
} from "@/lib/ai";
import { licenceOf, licenceWarning } from "@/editor/image-models";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Preset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  needsKey: boolean;
  note: string;
  models: Partial<Record<ServiceRole, string>>;
}

/** Where these things can run. Every field stays editable: any compatible endpoint works. */
const PRESETS: Preset[] = [
  {
    label: "This Mac",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8178/v1",
    needsKey: false,
    note: "A whisper.cpp server on this machine: free, and nothing leaves it.",
    models: { transcribe: "whisper-1" },
  },
  {
    label: "Draw Things",
    kind: "a1111",
    baseUrl: "http://127.0.0.1:7860",
    needsKey: false,
    note: "The Draw Things app on this Mac draws images, free and offline. In the app, turn on its API server (HTTP, port 7860). It draws with the model selected in the app: write that model's name here so looks can pin it, or current to follow the app. For client work pick an Apache 2.0 model — Z-Image Turbo, FLUX.2 [klein] 4B or Qwen-Image; FLUX.2 [klein] 9B and FLUX.1 dev are non-commercial.",
    models: { image: "current" },
  },
  {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    note: "One key for Claude, GPT, Gemini, Whisper and voices — Gemini TTS reads Hindi and English.",
    models: { transcribe: "openai/whisper-large-v3", chat: "anthropic/claude-sonnet-5", voice: "google/gemini-3.1-flash-tts-preview" },
  },
  {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    note: "Whisper, GPT, speech and images on one key.",
    models: { transcribe: "whisper-1", chat: "gpt-5", voice: "gpt-4o-mini-tts", image: "gpt-image-1" },
  },
  {
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    needsKey: true,
    note: "Claude, direct. No speech-to-text.",
    models: { chat: "claude-sonnet-5" },
  },
  {
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    note: "Whisper large-v3, fast and cheap.",
    models: { transcribe: "whisper-large-v3-turbo" },
  },
  {
    label: "ElevenLabs",
    kind: "elevenlabs",
    baseUrl: "https://api.elevenlabs.io/v1",
    needsKey: true,
    note: "Scribe for speech-to-text and its own voices: strong on Hindi and mixed speech.",
    models: { transcribe: "scribe_v2", voice: "eleven_v3" },
  },
];

const WHISPER_SERVER =
  "whisper-server -m ~/.cache/whisper-cpp/ggml-large-v3-turbo.bin --inference-path /v1/audio/transcriptions --convert -l auto --port 8178";

interface Draft {
  id: string | null;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: Partial<Record<ServiceRole, string>>;
  preset: string;
}

const draftFrom = (p: ProviderReport): Draft => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  baseUrl: p.baseUrl,
  apiKey: "",
  models: Object.fromEntries(SERVICE_ROLES.flatMap((role) => (modelOf(p, role) ? [[role, modelOf(p, role)!]] : []))),
  preset: PRESETS.find((x) => x.baseUrl === p.baseUrl)?.label ?? "",
});

const draftFromPreset = (preset: Preset): Draft => ({
  id: null,
  name: preset.label,
  kind: preset.kind,
  baseUrl: preset.baseUrl,
  apiKey: "",
  models: { ...preset.models },
  preset: preset.label,
});

const onThisMac = (url: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

function ServiceForm({ draft, onDone, onCancel }: { draft: Draft; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const preset = PRESETS.find((p) => p.label === form.preset);
  const set = (patch: Partial<Draft>) => setForm({ ...form, ...patch });

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const host = new URL(form.baseUrl).host.replace(/[^A-Za-z0-9_-]+/g, "-");
      const report = await saveProvider(form.id ?? `service-${host}`, {
        kind: form.kind,
        name: form.name.trim() || host,
        baseUrl: form.baseUrl,
        transcribeModel: form.models.transcribe ?? "",
        chatModel: form.models.chat ?? "",
        voiceModel: form.models.voice ?? "",
        imageModel: form.models.image ?? "",
        videoModel: form.models.video ?? "",
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      });
      const can = SERVICE_ROLES.filter((role) => canDo(report, role)).map((role) => ROLES[role].title.toLowerCase());
      toast.success(`${report.name} saved`, { description: can.length ? `Can do: ${can.join(", ")}.` : "Nothing it can do yet — check the models and the key." });
      const voiceFailed = report.voiceModel && report.capabilities?.voice === false ? report.capabilities.voiceMessage : undefined;
      const imageFailed = report.imageModel && report.capabilities?.image === false ? report.capabilities.imageMessage : undefined;
      if (!can.length) setFailure(report.capabilities?.chatMessage ?? voiceFailed ?? imageFailed ?? report.capabilities?.message ?? "It answered nothing useful.");
      else if (voiceFailed) setFailure(`Saved, but the voice model did not speak: ${voiceFailed}`);
      else if (imageFailed) setFailure(`Saved, but the image model did not draw: ${imageFailed}`);
      else onDone();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Could not save it.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant={form.preset === p.label ? "secondary" : "ghost"}
            className="h-6 px-2 text-[11px]"
            onClick={() => setForm({ ...draftFromPreset(p), id: form.id, apiKey: form.apiKey })}
          >
            {p.label}
          </Button>
        ))}
      </div>
      {preset && <p className="text-[11px] leading-snug text-muted-foreground">{preset.note}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Name</span>
          <Input className="h-8 text-xs" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Base URL</span>
          <Input className="h-8 text-xs" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">{form.id ? "API key — leave empty to keep the saved one" : preset?.needsKey ? "API key" : "API key (optional)"}</span>
        <Input className="h-8 text-xs" type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={form.id ? "•••• saved" : ""} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {SERVICE_ROLES.map((role) => (
          <label key={role} className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              {ROLES[role].title} model{ROLES[role].used ? "" : " · not used yet"}
            </span>
            <Input
              className="h-8 text-xs"
              value={form.models[role] ?? ""}
              placeholder="none"
              onChange={(e) => set({ models: { ...form.models, [role]: e.target.value } })}
            />
          </label>
        ))}
      </div>
      {licenceWarning(form.models.image ?? "", onThisMac(form.baseUrl)) && (
        <p className="rounded-md border border-amber-500/40 p-2 text-[11px] leading-snug text-amber-500">{licenceWarning(form.models.image ?? "", onThisMac(form.baseUrl))}</p>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        A key stays in <code className="font-mono">~/Cutline/ai.json</code> on this machine and is sent only to this URL. Saving asks the service what it
        can do: speech-to-text with a quarter-second of silence, the model with a few tokens, a voice by saying one word, an image model by drawing a 256 px picture.
      </p>
      {failure && (
        <div className="space-y-1 rounded-md border border-destructive/40 p-2 text-[11px] leading-snug">
          <p>{failure}</p>
          {form.preset === "This Mac" && (
            <>
              <p className="text-muted-foreground">LM Studio has no transcription endpoint. A whisper.cpp server on this machine does:</p>
              <code className="block break-all rounded bg-muted p-1 font-mono text-[10px]">{WHISPER_SERVER}</code>
            </>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" className="h-8 text-xs" disabled={busy || !form.baseUrl} onClick={() => void save()}>
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {busy ? "Asking it…" : form.id ? "Save changes" : "Connect"}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ServicesManager({
  project,
  dispatch,
}: {
  /** In a project: the roles it uses are shown and can be changed here. */
  project?: Project;
  dispatch?: (action: Action, coalesce?: boolean) => void;
}) {
  const [providers, setProviders] = useState<ProviderReport[] | null>(null);
  const [fallback, setFallback] = useState<Capabilities | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      listProviders().then(setProviders).catch(() => setProviders([])),
      capabilities().then(setFallback).catch(() => setFallback({ transcribe: null })),
    ]);
  useEffect(() => {
    void refresh();
  }, []);

  const services: ProjectServices = project?.services ?? {};
  const chosenFor = (role: ServiceRole) => {
    const own = services[role] ? providers?.find((p) => p.id === services[role] && canDo(p, role)) : undefined;
    if (own) return { name: own.name, model: modelOf(own, role) ?? "", own: true };
    const standard = fallback?.[role];
    return standard ? { name: standard.name, model: standard.model, own: false } : null;
  };

  return (
    <div className="space-y-4">
      {project && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">In this project</h3>
          <p className="text-[11px] text-muted-foreground">
            What each part of Cutline uses here. Left on the default, a role follows the workspace — the service connected last that can do the job.
          </p>
          <ul className="space-y-1">
            {SERVICE_ROLES.map((role) => {
              const able = (providers ?? []).filter((p) => canDo(p, role));
              const inUse = chosenFor(role);
              return (
                <li key={role} className="rounded-lg border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{ROLES[role].title}</span>
                    {!ROLES[role].used && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">nothing uses it yet</span>}
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {inUse ? `${inUse.name} · ${inUse.model}${inUse.own ? "" : " (default)"}` : "nothing connected"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{ROLES[role].blurb}</p>
                  <select
                    className="mt-1 h-7 w-full rounded-md border bg-transparent px-1 text-[11px]"
                    value={services[role] ?? ""}
                    disabled={!dispatch}
                    onChange={(e) => dispatch?.({ type: "setServices", patch: { [role]: e.target.value || undefined } })}
                  >
                    <option value="">
                      Workspace default{fallback?.[role] ? ` — ${fallback[role]!.name}` : " — none connected"}
                    </option>
                    {able.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {modelOf(p, role)}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-1.5">
        <div className="flex items-center">
          <h3 className="text-sm font-semibold">Connected services</h3>
          {!draft && (
            <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => setDraft(draftFromPreset(PRESETS[0]!))}>
              <Plus className="size-3.5" />
              Add a service
            </Button>
          )}
        </div>
        {draft && <ServiceForm draft={draft} onDone={() => { setDraft(null); void refresh(); }} onCancel={() => setDraft(null)} />}
        {providers === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : providers.length === 0 && !draft ? (
          <p className="text-xs text-muted-foreground">Nothing connected yet. Add one above — speech-to-text for captions, a model for the Director.</p>
        ) : (
          <ul className="space-y-1.5">
            {providers.map((p) => (
              <li key={p.id} className="rounded-lg border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold">{p.name}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{p.local ? "on this machine" : "hosted"}</span>
                  {p.hasKey && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">key saved</span>}
                  <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{p.baseUrl}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  {SERVICE_ROLES.map((role) => {
                    const model = modelOf(p, role);
                    if (!model) return null;
                    const ok = canDo(p, role);
                    return (
                      <span key={role} className="flex items-center gap-1">
                        {ok ? <Check className="size-3 text-primary" /> : <X className="size-3" />}
                        {ROLES[role].title.toLowerCase()} · <span className="font-mono">{model}</span>
                        {!ROLES[role].used && ok ? " (saved for later)" : ""}
                        {role === "image" && licenceOf(model, p.local) && (
                          <span className={licenceOf(model, p.local)!.commercial ? "" : "font-medium text-amber-500"}>
                            · {licenceOf(model, p.local)!.commercial ? licenceOf(model, p.local)!.name : "non-commercial"}
                          </span>
                        )}
                      </span>
                    );
                  })}
                  {p.transcribeModel && p.capabilities?.message && !p.capabilities.transcribe && <span className="truncate">{p.capabilities.message}</span>}
                  {p.voiceModel && p.capabilities?.voice === false && p.capabilities.voiceMessage && <span className="truncate">{p.capabilities.voiceMessage}</span>}
                  {p.imageModel && p.capabilities?.image === false && p.capabilities.imageMessage && <span className="truncate">{p.capabilities.imageMessage}</span>}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setDraft(draftFrom(p))}>
                    <Pencil className="size-3" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy === p.id}
                    onClick={async () => {
                      setBusy(p.id);
                      try {
                        const report = await probeProvider(p.id);
                        const can = SERVICE_ROLES.filter((role) => canDo(report, role)).map((role) => ROLES[role].title.toLowerCase());
                        toast.success(`${report.name}: ${can.length ? can.join(", ") : "nothing it can do"}`);
                        await refresh();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Could not reach it.");
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === p.id ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    Check again
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={async () => {
                      await removeProvider(p.id).catch(() => toast.error("Could not remove it."));
                      toast.success(`${p.name} removed`);
                      await refresh();
                    }}
                  >
                    <Trash2 className="size-3" />
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The same manager, as the editor's Services dialog. */
export function ServicesDialog({
  open,
  onOpenChange,
  project,
  dispatch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto p-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Services</DialogTitle>
          <DialogDescription className="text-[11px]">
            What this project uses, and everything connected on this machine. Keys stay in ~/Cutline and are sent only to the service they belong to.
          </DialogDescription>
        </DialogHeader>
        <ServicesManager project={project} dispatch={dispatch} />
      </DialogContent>
    </Dialog>
  );
}
