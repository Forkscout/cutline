/**
 * The Director panel: a thread with the agent that runs in this tab, the
 * phase it is in, and a box to tell it what to do. Plus the ⌘K bar that sends
 * to it from anywhere in the editor, and the form that connects a model where
 * it is first needed.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowUp, Check, LoaderCircle, RotateCcw, Square, X } from "lucide-react";
import { toast } from "sonner";
import { PROMPTS } from "@/editor/agent-guide";
import { PHASES, type Director, type ThreadItem } from "@/editor/director";
import type { Action } from "@/editor/project";
import type { Project } from "@/editor/types";
import { FactsAndChecks } from "@/components/editor/checks-panel";
import { capabilities, listProviders, saveProvider, type Capabilities, type ProviderKind, type ProviderReport } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  { title: PROMPTS.direct.title, text: () => PROMPTS.direct.text() },
  { title: PROMPTS.brief.title, text: () => PROMPTS.brief.text() },
  { title: PROMPTS.review.title, text: () => PROMPTS.review.text() },
];

const tokens = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);

interface ModelPreset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  note: string;
}

/** Where the Director's model can run. Every field stays editable: any OpenAI-compatible endpoint works. */
const MODEL_PRESETS: ModelPreset[] = [
  { label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5", needsKey: true,
    note: "Claude, direct. Sonnet 5 for most edits; claude-opus-5 for the hardest." },
  { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5", needsKey: true,
    note: "One key for Claude, GPT, Gemini and more — and the same key can transcribe." },
  { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5", needsKey: true,
    note: "OpenAI's models, direct." },
  { label: "This Mac", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "", needsKey: false,
    note: "LM Studio or any OpenAI-compatible server. Free and private; small models lose their way in long edits." },
];

/** Connecting the Director's model, in the place it is first needed. */
function ConnectDirector({ onConnected, onCancel }: { onConnected: () => void; onCancel?: () => void }) {
  const [providers, setProviders] = useState<ProviderReport[]>([]);
  useEffect(() => {
    listProviders().then(setProviders).catch(() => setProviders([]));
  }, []);
  const [preset, setPreset] = useState<ModelPreset>(MODEL_PRESETS[0]!);
  const [reuse, setReuse] = useState<ProviderReport | null>(null);
  const [baseUrl, setBaseUrl] = useState(MODEL_PRESETS[0]!.baseUrl);
  const [model, setModel] = useState(MODEL_PRESETS[0]!.model);
  const [apiKey, setApiKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A service already connected — for captions, say — keeps its key and can run the Director too.
  const reusable = providers.filter((p) => p.kind !== "elevenlabs" && p.capabilities?.flavor !== "whisper.cpp" && (p.hasKey || p.local));
  const choose = (next: ModelPreset) => {
    setPreset(next);
    setReuse(null);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setFailure(null);
  };
  const chooseExisting = (p: ProviderReport) => {
    const match = MODEL_PRESETS.find((m) => m.baseUrl === p.baseUrl);
    if (match) setPreset(match);
    setReuse(p);
    setBaseUrl(p.baseUrl);
    setModel(p.chatModel ?? match?.model ?? "");
    setFailure(null);
  };

  const connect = async () => {
    setChecking(true);
    setFailure(null);
    try {
      const host = new URL(baseUrl).host.replace(/[^A-Za-z0-9_-]+/g, "-");
      const report = await saveProvider(reuse?.id ?? `chat-${host}`, {
        kind: reuse?.kind ?? preset.kind,
        name: reuse?.name ?? (baseUrl === preset.baseUrl ? preset.label : new URL(baseUrl).host),
        baseUrl,
        ...(reuse ? { transcribeModel: reuse.transcribeModel } : {}),
        chatModel: model,
        ...(apiKey ? { apiKey } : {}),
      });
      if (report.capabilities?.chat) {
        toast.success(`The Director runs on ${report.chatModel} through ${report.name}`);
        onConnected();
      } else {
        setFailure(report.capabilities?.chatMessage ?? "The model did not answer.");
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Could not connect.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-1.5 p-2">
      <div className="flex items-center">
        <p className="text-[11px] font-medium">{onCancel ? "Change the Director's model" : "The Director needs a model"}</p>
        {onCancel && (
          <button className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:underline" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        It edits this project with the same tools an MCP agent uses, and asks before the big decisions. Bring a key from
        any of these.
      </p>
      {reusable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Already connected:</span>
          {reusable.map((p) => (
            <Button key={p.id} size="sm" className="h-5 px-1.5 text-[10px]" variant={reuse?.id === p.id ? "secondary" : "ghost"} onClick={() => chooseExisting(p)}>
              {p.name}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {MODEL_PRESETS.map((p) => (
          <Button key={p.label} size="sm" className="h-5 px-1.5 text-[10px]" variant={!reuse && preset.label === p.label ? "secondary" : "ghost"} onClick={() => choose(p)}>
            {p.label}
          </Button>
        ))}
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">{reuse ? `Uses the key already saved for ${reuse.name}.` : preset.note}</p>
      <Input className="h-6 text-[10px]" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL" disabled={Boolean(reuse)} />
      <div className="grid grid-cols-2 gap-1">
        <Input className="h-6 text-[10px]" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model" />
        <Input className="h-6 text-[10px]" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={reuse ? "Key saved" : preset.needsKey ? "API key" : "API key (optional)"} />
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">A key stays in ~/Cutline on this machine and is sent only to this URL.</p>
      <Button size="sm" className="h-6 w-full text-[10px]" disabled={checking || !baseUrl || !model.trim()} onClick={() => void connect()}>
        {checking ? "Asking the model…" : "Connect"}
      </Button>
      {failure && <p className="rounded-md border border-destructive/40 p-1.5 text-[10px] leading-snug">{failure}</p>}
    </div>
  );
}

/** **bold** and `code`, the two marks a model's reply leans on; the rest stays plain text. */
function Rich({ text }: { text: string }) {
  const parts: ReactNode[] = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded bg-muted px-0.5 font-mono text-[10px]">{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
  return <>{parts}</>;
}

function Item({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "user":
      return <div className="ml-6 line-clamp-6 whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-[11px]" title={item.text}>{item.text}</div>;
    case "director":
      return <div className="whitespace-pre-wrap text-[11px] leading-relaxed"><Rich text={item.text} /></div>;
    case "note":
      return <p className={cn("text-[10px] italic text-muted-foreground", item.tone === "error" && "not-italic text-destructive")}>{item.text}</p>;
    case "tool":
      return (
        <div className="text-[10px]">
          <div className="flex items-center gap-1">
            {item.status === "running" ? (
              <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : item.status === "ok" ? (
              <Check className="size-3 shrink-0 text-primary" />
            ) : (
              <X className="size-3 shrink-0 text-destructive" />
            )}
            <span className="font-mono">{item.name}</span>
            <span className="truncate text-muted-foreground">{item.summary}</span>
          </div>
          {item.status === "error" && item.detail && <p className="ml-4 break-words text-destructive">{item.detail}</p>}
          {item.image && <img src={item.image} alt={`${item.name} ${item.summary}`} className="ml-4 mt-1 w-[calc(100%-1rem)] rounded border" />}
        </div>
      );
  }
}

/** The Director tab: facts and checks, which need no model, above the thread with the agent. */
export function DirectorPanel({
  director,
  project,
  dispatch,
  onSeek,
}: {
  director: Director;
  project: Project;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onSeek: (time: number) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FactsAndChecks project={project} dispatch={dispatch} onSeek={onSeek} />
      <div className="min-h-0 flex-1 overflow-y-auto pt-1.5">
        <DirectorThread director={director} />
      </div>
    </div>
  );
}

function DirectorThread({ director }: { director: Director }) {
  const state = useSyncExternalStore(director.subscribe, director.getSnapshot);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = () => capabilities().then(setCaps).catch(() => setCaps({ transcribe: null, chat: null }));
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items.length, state.running]);

  if (caps === null) return null;
  if (!caps.chat || changing) {
    return (
      <ConnectDirector
        onConnected={() => {
          setChanging(false);
          void refresh();
        }}
        {...(caps.chat ? { onCancel: () => setChanging(false) } : {})}
      />
    );
  }

  const submit = () => {
    if (!draft.trim() || state.running) return;
    void director.send(draft);
    setDraft("");
  };
  const reached = state.phase ? PHASES.indexOf(state.phase) : -1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px]">
        <span className="truncate text-muted-foreground" title={`${caps.chat.name} · ${caps.chat.model}`}>{caps.chat.model}</span>
        <button className="shrink-0 text-muted-foreground underline-offset-2 hover:underline" onClick={() => setChanging(true)}>Change</button>
        <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground" title="Tokens the Director has used on this project: read · written">
          {tokens(state.usage.inputTokens)} · {tokens(state.usage.outputTokens)}
        </span>
        <button className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-40" title="New thread" aria-label="New thread"
          disabled={state.running} onClick={() => director.clear()}>
          <RotateCcw className="size-3" />
        </button>
      </div>
      <div className="flex gap-0.5 px-2" aria-label={`Phase: ${state.phase ?? "not started"}`}>
        {PHASES.map((p, i) => (
          <div key={p} title={p} className={cn("h-1 flex-1 rounded-full bg-muted", i < reached && "bg-primary/40", i === reached && "bg-primary")} />
        ))}
      </div>
      <div className="flex items-center gap-1 px-2 pt-1 text-[10px]">
        <span className="shrink-0 font-medium">{state.phase ?? "Not started"}</span>
        {state.doing && <span className="truncate text-muted-foreground">· {state.doing}</span>}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {state.items.length === 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] leading-snug text-muted-foreground">
              Tell the director what you want, or start with one of these. Every request is one undo step.
            </p>
            {SUGGESTIONS.map((s) => (
              <Button key={s.title} size="sm" variant="secondary" className="h-6 w-full justify-start text-[10px]" onClick={() => void director.send(s.text(), s.title)}>
                {s.title}
              </Button>
            ))}
          </div>
        )}
        {state.items.map((item, i) => (
          <Item key={i} item={item} />
        ))}
        {state.running && state.items.at(-1)?.kind !== "tool" && (
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" /> Thinking…</p>
        )}
      </div>

      <form
        className="border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          className="min-h-0 resize-none text-[11px]"
          placeholder="Tell the director… (⌘K from anywhere)"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-1 flex items-center">
          <span className="text-[9px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
          {state.running ? (
            <Button type="button" size="sm" variant="secondary" className="ml-auto h-6 text-[10px]" onClick={() => director.stop()}>
              <Square className="size-3" /> Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" className="ml-auto h-6 text-[10px]" disabled={!draft.trim()}>
              <ArrowUp className="size-3" /> Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

/** ⌘K: tell the director something from anywhere in the editor. */
export function DirectorCommand({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (text: string, shown?: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = (text: string, shown?: string) => {
    if (!text.trim()) return;
    onSubmit(text.trim(), shown);
    setDraft("");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[22%] translate-y-0 gap-2 p-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Tell the director</DialogTitle>
          <DialogDescription className="text-[11px]">It edits this project and shows its work in the Director tab. One undo step per request.</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="resize-none text-[12px]"
          placeholder="“Put the speaker in a side panel from 0:22 and add a title for each section”"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(draft);
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1">
          {SUGGESTIONS.map((s) => (
            <Button key={s.title} size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => submit(s.text(), s.title)}>
              {s.title}
            </Button>
          ))}
          <Button size="sm" className="ml-auto h-6 text-[10px]" disabled={!draft.trim()} onClick={() => submit(draft)}>
            <ArrowUp className="size-3" /> Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
