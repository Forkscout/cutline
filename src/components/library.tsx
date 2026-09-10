import { useCallback, useEffect, useState } from "react";
import { Camera, Download, HardDrive, Mic, Monitor, Scissors, Trash2, Volume2 } from "lucide-react";
import { toast } from "sonner";
import type { SessionMeta, SourceKind, TrackMeta } from "@/recorder/types";
import { deleteSession, estimateUsage, getTrackFile, listSessions } from "@/recorder/storage";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  const [url, setUrl] = useState<string | null>(null);
  const isVideo = track.kind === "screen" || track.kind === "camera";
  const { icon: Icon, tint } = ICON[track.kind];

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    void getTrackFile(session.id, track.fileName).then((file) => {
      if (cancelled) return;
      created = URL.createObjectURL(file);
      setUrl(created);
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [session.id, track.fileName]);

  const download = async () => {
    const file = await getTrackFile(session.id, track.fileName);
    const href = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${session.name.replace(/[^\w.-]+/g, "-")}-${track.fileName}`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[240px_1fr]">
      <div className="flex items-center">
        {url === null ? (
          <div className="aspect-video w-full animate-pulse rounded-md bg-muted" />
        ) : isVideo ? (
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
        <Button
          variant="secondary"
          size="sm"
          className="h-7 w-fit text-xs"
          onClick={() => void download()}
        >
          <Download className="size-3.5" />
          Download
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

  const reload = useCallback(() => {
    void listSessions().then(setSessions);
    void estimateUsage().then(setUsage);
  }, []);

  useEffect(reload, [reload, reloadKey]);

  const remove = async (session: SessionMeta) => {
    await deleteSession(session.id);
    toast(`Deleted ${formatDate(session.createdAt)}`);
    reload();
  };

  if (sessions === null) {
    return <Card className="h-40 animate-pulse" />;
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

      {sessions.length === 0 ? (
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
