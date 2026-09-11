/**
 * Settings: the services Cutline talks to, what agents may do here, and what
 * it has all cost. A place to manage, not a gate — a service is still
 * connected where a feature first needs it.
 */

import { useEffect, useState } from "react";
import { Check, Copy, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { capabilities, listProviders, probeProvider, removeProvider, saveProvider, type Capabilities, type ProviderReport } from "@/lib/ai";
import { getAgents, getUsage, rotateAgentToken, setPermissions, type AgentsView, type UsageSummary } from "@/lib/agents";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const ago = (at: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
};
const tokens = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);
const minutes = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`);

function Services() {
  const [providers, setProviders] = useState<ProviderReport[] | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      listProviders().then(setProviders).catch(() => setProviders([])),
      capabilities().then(setCaps).catch(() => setCaps({ transcribe: null, chat: null })),
    ]);
  useEffect(() => {
    void refresh();
  }, []);

  const use = async (p: ProviderReport, what: "captions" | "director") => {
    setBusy(p.id);
    try {
      // Saving a service again moves it to the front, which is what "use this one" means.
      await saveProvider(p.id, {
        kind: p.kind,
        name: p.name,
        baseUrl: p.baseUrl,
        transcribeModel: p.transcribeModel,
        ...(p.chatModel ? { chatModel: p.chatModel } : {}),
      });
      toast.success(`${p.name} is now the one for ${what === "captions" ? "captions" : "the Director"}`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch.");
    } finally {
      setBusy(null);
    }
  };

  if (!providers) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Keys stay in <code className="font-mono">~/Cutline/ai.json</code> on this machine and are sent only to the service they belong to. Add one where
        you need it: the Captions panel for speech-to-text, the Director tab for a model.
      </p>
      {providers.length === 0 && <p className="text-sm text-muted-foreground">Nothing connected yet.</p>}
      <ul className="space-y-2">
        {providers.map((p) => {
          const forCaptions = caps?.transcribe?.providerId === p.id;
          const forDirector = caps?.chat?.providerId === p.id;
          return (
            <li key={p.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{p.name}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px]", p.local ? "bg-muted text-muted-foreground" : "bg-muted text-muted-foreground")}>
                  {p.local ? "on this machine" : "hosted"}
                </span>
                {forCaptions && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">captions</span>}
                {forDirector && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">director</span>}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{p.baseUrl}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  {p.capabilities?.transcribe ? <Check className="size-3 text-primary" /> : <X className="size-3" />}
                  speech-to-text{p.capabilities?.transcribe ? ` · ${p.transcribeModel}` : ""}
                </span>
                <span className="flex items-center gap-1">
                  {p.capabilities?.chat ? <Check className="size-3 text-primary" /> : <X className="size-3" />}
                  model{p.capabilities?.chat && p.chatModel ? ` · ${p.chatModel}` : ""}
                </span>
                <span>{p.hasKey ? "key saved" : "no key"}</span>
                {p.capabilities?.message && !p.capabilities.transcribe && <span className="truncate">{p.capabilities.message}</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {p.capabilities?.transcribe && !forCaptions && (
                  <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={busy === p.id} onClick={() => void use(p, "captions")}>
                    Use for captions
                  </Button>
                )}
                {p.capabilities?.chat && !forDirector && (
                  <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={busy === p.id} onClick={() => void use(p, "director")}>
                    Use for the Director
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={busy === p.id}
                  onClick={async () => {
                    setBusy(p.id);
                    try {
                      const report = await probeProvider(p.id);
                      toast.success(`${report.name}: ${report.capabilities?.transcribe ? "transcribes" : "no speech-to-text"}, ${report.capabilities?.chat ? "answers" : "no model"}`);
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
                  className="ml-auto h-7 text-xs"
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
          );
        })}
      </ul>
    </div>
  );
}

function Agents() {
  const [view, setView] = useState<AgentsView | null>(null);
  const refresh = () => getAgents().then(setView).catch(() => setView(null));
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!view) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const toggle = async (key: keyof AgentsView["permissions"], value: boolean) => {
    try {
      const next = await setPermissions({ [key]: value });
      setView({ ...view, permissions: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save that.");
    }
  };

  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <h3 className="text-sm font-semibold">Connect an agent</h3>
        <p className="text-xs text-muted-foreground">
          Run this where your agent lives. It registers Cutline as an MCP server; the token sits in{" "}
          <code className="font-mono">{view.tokenFile}</code>, ending {view.tokenTail}.
        </p>
        <div className="flex items-start gap-2">
          <code className="flex-1 break-all rounded-lg bg-muted p-2 font-mono text-[11px]">{view.registration}</code>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-xs"
            onClick={() => {
              void navigator.clipboard.writeText(view.registration).then(
                () => toast.success("Copied"),
                () => toast.error("Could not copy it."),
              );
            }}
          >
            <Copy className="size-3.5" />
            Copy
          </Button>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground">
              Rotate the token
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Rotate the agent token?</AlertDialogTitle>
              <AlertDialogDescription>
                Every agent registered with the old token stops working until you give it the new line. Nothing else changes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  void rotateAgentToken().then(
                    () => {
                      toast.success("New token written. Register your agents again.");
                      void refresh();
                    },
                    (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not rotate it."),
                  );
                }}
              >
                Rotate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-sm font-semibold">What agents may do here</h3>
        {(
          [
            ["mayExport", "Export video", "Render and save a file under exports/."],
            ["mayImport", "Import files", "Bring recordings and workspace files into a project."],
            ["mayDeleteOthersClips", "Delete clips it did not make", "Clips with no sign of an agent behind them are yours; the tab refuses otherwise."],
          ] as const
        ).map(([key, title, blurb]) => (
          <label key={key} className="flex items-start gap-3 rounded-xl border p-3">
            <Switch checked={view.permissions[key]} onCheckedChange={(on) => void toggle(key, on)} />
            <span>
              <span className="block text-xs font-medium">{title}</span>
              <span className="block text-[11px] text-muted-foreground">{blurb}</span>
            </span>
          </label>
        ))}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-sm font-semibold">Connected</h3>
        <p className="text-[11px] text-muted-foreground">Since the server started, {ago(view.since)}. Editors are the tabs the agent's edits land in.</p>
        <ul className="space-y-1">
          {view.clients.length === 0 && <li className="text-xs text-muted-foreground">No agent has called yet.</li>}
          {view.clients.map((client) => (
            <li key={client.name} className="rounded-lg border px-3 py-2 text-xs">
              <span className="font-medium">{client.name}</span>
              {client.version && <span className="text-muted-foreground"> {client.version}</span>}
              <span className="text-muted-foreground">
                {" "}
                · {client.calls} calls · last {ago(client.lastSeen)}
              </span>
              {client.recent.length > 0 && <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{client.recent.join(" · ")}</span>}
            </li>
          ))}
          {view.editors.map((editor) => (
            <li key={`${editor.projectId}-${editor.connectedAt}`} className="rounded-lg border px-3 py-2 text-xs">
              <span className="font-medium">{editor.name}</span>
              <span className="text-muted-foreground">
                {" "}
                · editor{editor.holder ? " · saves this project" : ""} · touched {ago(editor.seenAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Usage() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [days, setDays] = useState(30);
  useEffect(() => {
    void getUsage(days).then(setUsage).catch(() => setUsage(null));
  }, [days]);
  if (!usage) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const peak = Math.max(1, ...usage.byDay.map((d) => d.inputTokens + d.outputTokens));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">What the agents have spent</h3>
        <select className="ml-auto h-8 rounded-lg border bg-card px-2 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Read from <code className="font-mono">~/Cutline/usage.jsonl</code>, which every model and transcription call appends to. These are tokens and
        minutes, not money: what they cost is your provider's to say.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Calls", String(usage.totals.calls)],
          ["Read", tokens(usage.totals.inputTokens)],
          ["Written", tokens(usage.totals.outputTokens)],
          ["Transcribed", minutes(usage.totals.transcribedSeconds)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border p-3">
            <span className="block text-lg font-semibold tabular-nums">{value}</span>
            <span className="text-[11px] text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      {usage.byDay.length > 0 && (
        <div className="flex h-24 items-end gap-1">
          {usage.byDay.map((d) => (
            <div key={d.day} className="flex-1" title={`${d.day}: ${tokens(d.inputTokens)} read, ${tokens(d.outputTokens)} written`}>
              <div className="rounded-t bg-primary/70" style={{ height: `${Math.max(2, ((d.inputTokens + d.outputTokens) / peak) * 96)}px` }} />
            </div>
          ))}
        </div>
      )}
      {usage.byModel.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold">By model</h4>
          <ul className="mt-1 space-y-1">
            {usage.byModel.map((m) => (
              <li key={`${m.provider}:${m.model}`} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs">
                <span className="font-mono">{m.model}</span>
                <span className="text-muted-foreground">{m.provider}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {m.calls} calls · {tokens(m.inputTokens)} in · {tokens(m.outputTokens)} out
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {usage.byProject.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold">By project</h4>
          <ul className="mt-1 space-y-1">
            {usage.byProject.map((p) => (
              <li key={p.projectId} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs">
                <span className="truncate font-mono text-[11px]">{p.projectId}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {p.calls} calls · {tokens(p.inputTokens + p.outputTokens)} tokens
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function Settings() {
  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="text-xl font-bold tracking-tight">Settings</h1>
      <Tabs defaultValue="services" className="mt-4">
        <TabsList className="h-9">
          <TabsTrigger value="services" className="text-xs">AI services</TabsTrigger>
          <TabsTrigger value="agents" className="text-xs">Agents</TabsTrigger>
          <TabsTrigger value="usage" className="text-xs">Usage</TabsTrigger>
        </TabsList>
        <TabsContent value="services" className="mt-4">
          <Services />
        </TabsContent>
        <TabsContent value="agents" className="mt-4">
          <Agents />
        </TabsContent>
        <TabsContent value="usage" className="mt-4">
          <Usage />
        </TabsContent>
      </Tabs>
    </div>
  );
}
