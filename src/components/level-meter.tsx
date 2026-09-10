import { AlertTriangle } from "lucide-react";
import { useAudioLevel } from "@/hooks/use-audio-level";
import { cn } from "@/lib/utils";

/** After this long with no sound, say so — while the take can still be saved. */
const WARN_AFTER_MS = 4000;

/**
 * Sixteen segments rather than a continuous bar: a bar that is "roughly two
 * thirds full" tells you nothing you can act on, whereas segments read as a
 * count at a glance and make a dead input unmistakable.
 */
const SEGMENTS = 16;

export function LevelMeter({
  stream,
  active,
  recording,
  tone = "onLight",
}: {
  stream: MediaStream | null;
  active: boolean;
  recording: boolean;
  /** The meter sits on the deep-green stage as well as on paper. */
  tone?: "onLight" | "onDark";
}) {
  const { level, peak, everHeard, silentFor } = useAudioLevel(stream, active);
  const lit = Math.round(level * SEGMENTS);
  const peakSegment = Math.round(peak * SEGMENTS);
  const warn = silentFor > WARN_AFTER_MS;
  const dark = tone === "onDark";

  return (
    <div className="space-y-2">
      <div className="flex h-2 gap-[3px]">
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const on = i < lit;
          const isPeak = i === peakSegment - 1 && peakSegment > lit;
          return (
            <div
              key={i}
              className={cn(
                "flex-1 rounded-full transition-colors duration-75",
                !on && !isPeak && (dark ? "bg-white/15" : "bg-muted"),
                isPeak && (dark ? "bg-white/60" : "bg-foreground/50"),
                on && i < SEGMENTS * 0.7 && "bg-primary",
                on && i >= SEGMENTS * 0.7 && i < SEGMENTS * 0.88 && "bg-amber-400",
                on && i >= SEGMENTS * 0.88 && "bg-record",
              )}
            />
          );
        })}
      </div>
      {warn && (
        <p
          className={cn(
            "flex items-center gap-1.5 text-xs font-medium",
            dark ? "text-amber-300" : "text-amber-600",
          )}
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          {everHeard
            ? `Silent for ${Math.round(silentFor / 1000)}s`
            : recording
              ? "Nothing heard since recording started — check the input"
              : "No sound yet — say something to check the level"}
        </p>
      )}
    </div>
  );
}
