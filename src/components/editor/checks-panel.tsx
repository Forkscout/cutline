/**
 * Facts to confirm and the edit's checks, at the top of the Director panel.
 * They work with no model connected: the same scan list_facts runs, and the
 * same lint an agent runs, on the project as it is.
 */

import { useDeferredValue, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { needsConfirming, scanNumbers, type OnScreenNumber } from "@/editor/facts";
import { lintScene, type LintReport } from "@/editor/lint";
import type { Action } from "@/editor/project";
import type { Fact, Project } from "@/editor/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

type Dispatch = (action: Action, coalesce?: boolean) => void;

function FactRow({ entry, dispatch, onSeek }: { entry: OnScreenNumber; dispatch: Dispatch; onSeek: (t: number) => void }) {
  const [fixing, setFixing] = useState(false);
  const [to, setTo] = useState(entry.value);
  const first = entry.shown[0];
  const save = (status: Fact["status"]) =>
    dispatch({
      type: "setFact",
      fact: {
        id: entry.fact?.id ?? crypto.randomUUID(),
        value: entry.value,
        status,
        source: entry.fact?.source ?? "scan",
        ...(first ? { time: first.start } : entry.fact?.time !== undefined ? { time: entry.fact.time } : {}),
        ...(entry.fact?.note ? { note: entry.fact.note } : {}),
      },
    });
  const at = first?.start ?? entry.fact?.time;
  return (
    <div className="space-y-1 rounded-md border p-1.5 text-[10px]">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] font-semibold">{entry.value}</span>
        {at !== undefined && (
          <button className="text-muted-foreground underline-offset-2 hover:underline" onClick={() => onSeek(at + 0.7)}>
            {mmss(at)}
            {entry.shown.length > 1 ? ` +${entry.shown.length - 1}` : ""}
          </button>
        )}
        <span className="ml-auto text-muted-foreground">{entry.fact?.status === "open" ? "flagged" : "not heard nearby"}</span>
      </div>
      {first && <p className="truncate" title={first.text}>{first.text}</p>}
      {entry.fact?.note && <p className="text-muted-foreground">{entry.fact.note}</p>}
      {entry.excerpt && <p className="line-clamp-2 text-muted-foreground" title={entry.excerpt}>Heard: “{entry.excerpt}”</p>}
      {fixing ? (
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!to.trim() || to.trim() === entry.value) return;
            dispatch({ type: "correctFact", id: entry.fact?.id ?? crypto.randomUUID(), from: entry.value, to: to.trim() });
            setFixing(false);
          }}
        >
          <Input className="h-5 text-[10px]" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
          <Button type="submit" size="sm" className="h-5 px-1.5 text-[10px]" disabled={!to.trim() || to.trim() === entry.value}>Replace everywhere</Button>
        </form>
      ) : (
        <div className="flex gap-1">
          <Button size="sm" variant="secondary" className="h-5 px-1.5 text-[10px]" onClick={() => save("confirmed")}>Right as shown</Button>
          <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => setFixing(true)}>Correct…</Button>
          <Button size="sm" variant="ghost" className="ml-auto h-5 px-1.5 text-[10px]" onClick={() => save("dismissed")}>Not a fact</Button>
        </div>
      )}
    </div>
  );
}

export function FactsAndChecks({ project, dispatch, onSeek }: { project: Project; dispatch: Dispatch; onSeek: (t: number) => void }) {
  const [open, setOpen] = useState<"facts" | "checks" | null>(null);
  const [report, setReport] = useState<LintReport | null>(null);
  const [checking, setChecking] = useState(false);
  // Scanned as the user edits, a beat behind, so a drag stays smooth.
  const settled = useDeferredValue(project);
  const pending = useMemo(() => {
    const numbers = scanNumbers(settled);
    const onScreen = new Set(numbers.flatMap((n) => (n.fact ? [n.fact.id] : [])));
    const flagged: OnScreenNumber[] = settled.facts
      .filter((f) => f.status === "open" && !onScreen.has(f.id))
      .map((f) => ({ value: f.value, shown: [], heard: false, excerpt: "", fact: f }));
    return [...numbers.filter(needsConfirming), ...flagged];
  }, [settled]);

  const run = async () => {
    setChecking(true);
    setOpen("checks");
    try {
      setReport(await lintScene(project));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The checks could not run.");
    } finally {
      setChecking(false);
    }
  };
  const errors = report?.issues.filter((i) => i.severity === "error").length ?? 0;

  return (
    <div className="border-b px-2 pb-1.5">
      <div className="flex items-center gap-2 text-[10px]">
        <button className="flex items-center gap-0.5 hover:text-foreground" onClick={() => setOpen(open === "facts" ? null : "facts")}>
          <ChevronRight className={cn("size-3 transition-transform", open === "facts" && "rotate-90")} />
          Facts to confirm
          <span className={cn("rounded px-1 font-mono", pending.length ? "bg-muted text-foreground" : "text-muted-foreground")}>{pending.length}</span>
        </button>
        <button className="flex items-center gap-0.5 hover:text-foreground" onClick={() => (report ? setOpen(open === "checks" ? null : "checks") : void run())}>
          <ChevronRight className={cn("size-3 transition-transform", open === "checks" && "rotate-90")} />
          Checks
          {report && <span className="rounded bg-muted px-1 font-mono">{report.issues.length}</span>}
        </button>
        <Button size="sm" variant="ghost" className="ml-auto h-5 px-1.5 text-[10px]" disabled={checking} onClick={() => void run()}>
          {checking ? <LoaderCircle className="size-3 animate-spin" /> : null}
          {checking ? "Checking…" : report ? "Check again" : "Run checks"}
        </Button>
      </div>
      {open === "facts" && (
        <div className="mt-1 max-h-60 space-y-1 overflow-y-auto">
          {pending.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">Every number on screen was said nearby, or has been confirmed.</p>
          ) : (
            pending.map((entry) => <FactRow key={`${entry.value}:${entry.fact?.id ?? ""}`} entry={entry} dispatch={dispatch} onSeek={onSeek} />)
          )}
        </div>
      )}
      {open === "checks" && report && (
        <div className="mt-1 max-h-60 space-y-0.5 overflow-y-auto">
          <p className="text-[10px] text-muted-foreground">
            {report.issues.length ? `${errors} errors, ${report.issues.length - errors} warnings` : "Clean"} · {report.checked} graphics,{" "}
            {report.contrastMeasured} measured for contrast
          </p>
          {report.issues.map((issue, i) => (
            <button key={i} className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-[10px] hover:bg-accent" onClick={() => onSeek(issue.time)} title={issue.fix}>
              <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", issue.severity === "error" ? "bg-destructive" : "bg-amber-400")} />
              <span className="shrink-0 font-mono text-muted-foreground">{mmss(issue.time)}</span>
              <span>{issue.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
