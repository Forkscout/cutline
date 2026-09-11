import { AudioWaveform, Monitor, User } from "lucide-react";

/**
 * Illustrations for the capture-mode cards.
 *
 * Drawn rather than photographed: before the user has granted anything there is
 * no camera frame to show, and a stock face would promise a preview the app
 * cannot give yet. These say what each mode captures using only the app's own
 * two greens.
 */

function ScreenMock({ children }: { children?: React.ReactNode }) {
  return (
    <div className="relative flex size-full flex-col justify-between overflow-hidden rounded-xl bg-surface-deep p-5">
      <div>
        <p className="font-mono text-4xl font-semibold tracking-tight text-surface-deep-foreground">
          2:35
        </p>
        <p className="mt-0.5 text-[11px] font-medium text-surface-deep-foreground/60">
          Friday, May 8
        </p>
      </div>
      {/* A dock reads as "a desktop" faster than any icon would. */}
      <div className="flex items-end gap-1.5">
        <div className="flex flex-1 gap-1.5 rounded-lg bg-white/10 p-1.5">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-4 flex-1 rounded bg-white/20" />
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

function CameraBadge({ round = false }: { round?: boolean }) {
  return (
    <div
      className={cnJoin(
        "grid size-14 shrink-0 place-items-center border-2 border-surface-deep bg-primary/90",
        round ? "rounded-full" : "rounded-lg",
      )}
    >
      <User className="size-6 text-primary-foreground" />
    </div>
  );
}

function cnJoin(...parts: (string | false | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function ModeArt({ mode }: { mode: "screen" | "camera" | "screen-camera" | "audio" }) {
  if (mode === "screen") return <ScreenMock />;

  if (mode === "screen-camera") {
    return (
      <ScreenMock>
        <CameraBadge />
      </ScreenMock>
    );
  }

  if (mode === "camera") {
    return (
      <div className="grid size-full place-items-center overflow-hidden rounded-xl bg-surface-deep">
        <div className="grid size-24 place-items-center rounded-2xl bg-primary/90">
          <User className="size-12 text-primary-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex size-full items-center justify-center gap-1.5 overflow-hidden rounded-xl bg-surface-deep px-6">
      {[0.35, 0.6, 0.45, 0.8, 1, 0.7, 0.9, 0.5, 0.75, 0.4, 0.55].map((h, i) => (
        <div
          key={i}
          className="w-2 rounded-full bg-primary"
          style={{ height: `${h * 62}%` }}
        />
      ))}
    </div>
  );
}

export const MODE_ICON = { screen: Monitor, camera: User, audio: AudioWaveform } as const;
