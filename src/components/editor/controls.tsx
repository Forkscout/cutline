import { Diamond, RotateCcw } from "lucide-react";
import type { Action } from "@/editor/project";
import { keyframesFor, valueAt } from "@/editor/keyframes";
import type { Clip, ClipRef, Easing } from "@/editor/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export function Field({
  label,
  value,
  onReset,
  children,
}: {
  label: string;
  value?: string;
  onReset?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <Label className="text-[11px] text-muted-foreground">{label}</Label>
        {value && <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{value}</span>}
        {onReset && (
          <Button variant="ghost" size="icon" className="size-4" title="Reset" onClick={onReset}>
            <RotateCcw className="size-2.5" />
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A slider with a keyframe stopwatch.
 *
 * The stopwatch is the whole reason this is a component rather than a bare
 * Slider: animating a property has to be reachable from the same control that
 * sets it, or nobody finds it. Dragging a keyframed property writes a keyframe
 * at the playhead rather than changing the static value, which is what every
 * editor does and what surprises people when it is missing.
 */
export function NumberSlider({
  label,
  path,
  clip,
  clipRef,
  localTime,
  value,
  min,
  max,
  step,
  format,
  defaultValue,
  dispatch,
  onChange,
}: {
  label: string;
  path?: string;
  clip?: Clip;
  clipRef?: ClipRef | null;
  localTime?: number;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  defaultValue?: number;
  dispatch: (action: Action, coalesce?: boolean) => void;
  onChange: (value: number, coalesce: boolean) => void;
}) {
  const animatable = Boolean(path && clip && clipRef && localTime !== undefined);
  const keys = animatable ? keyframesFor(clip!, path!) : [];
  const animated = keys.length > 0;
  const atPlayhead =
    animated && keys.some((k) => Math.abs(k.time - (localTime ?? 0)) < 1 / 60);
  const shown = animated ? (valueAt(clip!, path!, localTime ?? 0) ?? value) : value;

  const write = (next: number, coalesce: boolean) => {
    if (animated && clipRef && path) {
      dispatch(
        {
          type: "addKeyframe",
          ref: clipRef,
          keyframe: {
            id: crypto.randomUUID(),
            property: path,
            time: localTime ?? 0,
            value: next,
            easing: "ease" as Easing,
          },
        },
        coalesce,
      );
      return;
    }
    onChange(next, coalesce);
  };

  const toggleKeyframe = () => {
    if (!clipRef || !path || !clip) return;
    if (atPlayhead) {
      const existing = keys.find((k) => Math.abs(k.time - (localTime ?? 0)) < 1 / 60);
      if (existing) dispatch({ type: "removeKeyframe", ref: clipRef, keyframeId: existing.id });
      return;
    }
    dispatch({
      type: "addKeyframe",
      ref: clipRef,
      keyframe: {
        id: crypto.randomUUID(),
        property: path,
        time: localTime ?? 0,
        value: shown,
        easing: "ease",
      },
    });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label className="text-[11px] text-muted-foreground">{label}</Label>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {format ? format(shown) : shown.toFixed(2)}
        </span>
        {defaultValue !== undefined && (
          <Button
            variant="ghost"
            size="icon"
            className="size-4"
            title="Reset"
            onClick={() => write(defaultValue, false)}
          >
            <RotateCcw className="size-2.5" />
          </Button>
        )}
        {animatable && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-4", animated && "text-primary")}
            title={atPlayhead ? "Remove keyframe" : "Add keyframe at playhead"}
            onClick={toggleKeyframe}
          >
            <Diamond className={cn("size-2.5", atPlayhead && "fill-current")} />
          </Button>
        )}
      </div>
      <Slider
        value={[shown]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => write(v ?? shown, true)}
        onValueCommit={([v]) => write(v ?? shown, false)}
      />
    </div>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <input
        type="color"
        value={value.startsWith("#") ? value : "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        className="ml-auto size-6 cursor-pointer rounded border bg-transparent"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-20 text-[10px]"
      />
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="ml-auto size-3.5 accent-[var(--primary)]"
      />
    </label>
  );
}
