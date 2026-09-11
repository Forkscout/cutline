import { useCallback, useEffect, useState } from "react";
import { Camera, Download, HardDrive, Mic, Monitor, MousePointer2, Scissors, Trash2, Volume2 } from "lucide-react";
import { toast } from "sonner";
import type { SessionMeta, SourceKind, TrackMeta } from "@/recorder/types";
import { deleteSession, estimateUsage, listSessions, sessionFileUrl } from "@/lib/media-store";
import { syncLocalRecordings } from "@/lib/sync";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { describeFormat, formatBytes, formatDate, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICON: Record<SourceKind, { icon: typeof Monitor; tint: string }> = {
  screen: { icon: Monitor, tint: "text-sky-400" },
  camera: { icon: Camera, tint: "text-emerald-400" },
  microphone: { icon: Mic, tint: "text-amber-400" },
  "system-audio": { icon: Volume2, tint: "text-violet-400" },
};

function TrackRow({ session, track }: { session: SessionMeta; track: TrackMeta }) {
  const isVideo = track.kind === "screen" || track.kind === "camera";
  const { icon: Icon, tint } = ICON[track.kind];
  // A server URL, not a blob: the element streams with range requests, so a
  // two-hour take is playable immediately instead of after reading it all in.
  const url = sessionFileUrl(session.id, track.fileName);

  return (
    <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[240px_1fr]">
      <div className="flex items-center">
        {isVideo ? (
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full rounded-md bg-black"
          />
        ) : (
          <div className="w-full space-y-2 rounded-md bg-black/40 p-3">
            <Icon className={cn("size-6 opacity-50", tint)} />
            <audio src={url} controls preload="metadata" className="w-full" />
          </div>
        )}
      </div>

      <div className="flex flex-col justify-center gap-2">
        <div className="flex items-center gap-2">
          <Icon className={cn("size-4", tint)} />
          <span className="text-sm font-medium">{track.label}</span>
          <Badge variant="outline" className="ml-auto font-mono text-[10px]">
            {track.fileName}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
          <span>{describeFormat(track)}</span>
          <span>{formatDuration(track.durationMs)}</span>
          <span>{formatBytes(track.bytes)}</span>
          <span className="text-primary" title="Milliseconds after the session clock started">
            +{track.offsetMs} ms
          </span>
          {track.pauses.length > 0 && (
            <span>
              {track.pauses.length} pause{track.pauses.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <Button variant="secondary" size="sm" className="h-7 w-fit text-xs" asChild>
          <a href={url} download={`${session.name.replace(/[^\w.-]+/g, "-")}-${track.fileName}`}>
            <Download className="size-3.5" />
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}

export function Library({
  reloadKey,
  onEdit,
}: {
  reloadKey: number;
  onEdit: (session: SessionMeta) => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const reload = useCallback(() => {
    // Anything the recorder left in the browser goes up first, so a take that
    // just finished is in the list rather than appearing on the next visit.
    syncLocalRecordings((p) => setSyncing(`Moving recordings to disk — ${p.done + 1} of ${p.total}`))
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not move recordings to disk.");
      })
      .finally(() => setSyncing(null))
      .then(() => Promise.all([listSessions(), estimateUsage()]))
      .then(([list, disk]) => {
        setError(null);
        setSessions(list);
        setUsage(disk);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not reach the Cutline server.");
        setSessions([]);
      });
  }, []);

  useEffect(reload, [reload, reloadKey]);

  const remove = async (session: SessionMeta) => {
    try {
      await deleteSession(session.id);
      toast(`Deleted ${formatDate(session.createdAt)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the recording.");
    }
    reload();
  };

  if (sessions === null) {
    return (
      <div className="space-y-3">
        <Card className="h-40 animate-pulse" />
        {syncing && <p className="text-xs text-muted-foreground">{syncing}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl font-extrabold">Your recordings</h1>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <HardDrive className="size-3.5" />
          {formatBytes(usage.usage)} used
          {usage.quota > 0 && ` of ${formatBytes(usage.quota)} available`}
        </span>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Recordings are unavailable</AlertTitle>
          <AlertDescription className="text-xs">
            {error} Finished takes are kept by the local server. Anything you record
            meanwhile is safe in the browser and moves across once it is running.
          </AlertDescription>
        </Alert>
      )}

      {sessions.length === 0 && !error ? (
        <Card className="flex h-44 items-center justify-center border-dashed shadow-none">
          <p className="text-sm text-muted-foreground">
            Nothing recorded yet — start a take from the Record tab.
          </p>
        </Card>
      ) : (
        <Accordion type="single" collapsible className="space-y-3">
          {sessions.map((session) => (
            <AccordionItem
              key={session.id}
              value={session.id}
              className="rounded-2xl border bg-card px-4 shadow-sm last:border-b"
            >
              <div className="flex items-center gap-2">
                <AccordionTrigger className="flex-1 hover:no-underline">
                  <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 pr-2">
                    <span className="text-sm font-medium">{formatDate(session.createdAt)}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatDuration(session.durationMs)}
                    </span>
                    <div className="flex gap-1">
                      {session.tracks.map((t) => {
                        const { icon: Icon, tint } = ICON[t.kind];
                        return <Icon key={t.id} className={cn("size-3.5", tint)} />;
                      })}
                      {session.cursor && (
                        <MousePointer2 className="size-3.5 text-muted-foreground" aria-label="Cursor track" />
                      )}
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatBytes(session.tracks.reduce((n, t) => n + t.bytes, 0))}
                    </span>
                  </div>
                </AccordionTrigger>

                <Button
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => onEdit(session)}
                >
                  <Scissors className="size-3.5" />
                  Edit
                </Button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8 shrink-0">
                      <Trash2 className="size-4 text-muted-foreground" />
                      <span className="sr-only">Delete recording</span>
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {session.tracks.length} files,{" "}
                        {formatBytes(session.tracks.reduce((n, t) => n + t.bytes, 0))}. This
                        cannot be undone — download anything you want to keep first.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => void remove(session)}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <AccordionContent className="space-y-3 pb-4">
                {session.tracks.map((track) => (
                  <TrackRow key={track.id} session={session} track={track} />
                ))}
                {session.cursor && (
                  <div className="flex items-center gap-2 rounded-lg border p-3 text-xs text-muted-foreground">
                    <MousePointer2 className="size-4" />
                    <span className="font-medium text-foreground">Cursor track</span>
                    <span>{formatBytes(session.cursor.bytes)} · positions and clicks, for auto-zoom later</span>
                  </div>
                )}
                <Alert>
                  <AlertDescription className="text-xs leading-relaxed">
                    Scrubbing inside these files is unreliable until they are remuxed —
                    MediaRecorder cannot write a duration into a WebM header after the fact.
                    The durations above are Cutline's own measurements and are the ones the
                    editor will use.
                  </AlertDescription>
                </Alert>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}
