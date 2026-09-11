/**
 * The form an agent's ask_client opens in the editor. Each question carries a
 * suggested answer, so accepting the agent's defaults is one click.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { openRequest, settle, subscribe, type QuestionRequest } from "@/editor/client-questions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function initial(request: QuestionRequest): Record<string, string | string[]> {
  return Object.fromEntries(
    request.questions.map((q) => [q.id, q.kind === "multi" ? (q.suggested ? q.suggested.split(",").map((s) => s.trim()) : []) : (q.suggested ?? "")]),
  );
}

export function ClientQuestionsDialog() {
  const request = useSyncExternalStore(subscribe, openRequest);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  useEffect(() => {
    if (request) setAnswers(initial(request));
  }, [request]);
  if (!request) return null;

  const set = (id: string, value: string | string[]) => setAnswers((a) => ({ ...a, [id]: value }));
  return (
    <Dialog open onOpenChange={(open) => !open && settle(request.id, { status: "declined" })}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>The agent working on this video is asking. Suggested answers are filled in — change what you like.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {request.questions.map((q) => (
            <div key={q.id} className="space-y-1.5">
              <p className="text-sm font-medium">{q.question}</p>
              {q.why && <p className="text-xs text-muted-foreground">{q.why}</p>}
              {q.kind === "text" && (
                <Input value={String(answers[q.id] ?? "")} placeholder={q.suggested ?? ""} onChange={(e) => set(q.id, e.target.value)} />
              )}
              {q.kind !== "text" && (
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((option) => {
                    const current = answers[q.id];
                    const chosen = Array.isArray(current) ? current.includes(option) : current === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs transition-colors",
                          chosen ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => {
                          if (q.kind === "multi") {
                            const list = Array.isArray(current) ? current : [];
                            set(q.id, chosen ? list.filter((o) => o !== option) : [...list, option]);
                          } else set(q.id, option);
                        }}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(request.id, { status: "declined" })}>
            Not now
          </Button>
          <Button onClick={() => settle(request.id, { status: "answered", answers })}>Send answers</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
