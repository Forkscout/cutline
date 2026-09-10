export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "1920×1080 · 30 fps" or "48 kHz stereo", whichever the track is. */
export function describeFormat(t: {
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channelCount?: number;
}): string {
  if (t.width && t.height) {
    const fps = t.frameRate ? ` · ${Math.round(t.frameRate)} fps` : "";
    return `${t.width}×${t.height}${fps}`;
  }
  if (t.sampleRate) {
    const channels = t.channelCount === 2 ? "stereo" : t.channelCount === 1 ? "mono" : "";
    return `${Math.round(t.sampleRate / 100) / 10} kHz${channels ? ` ${channels}` : ""}`;
  }
  return "";
}

/** mm:ss.ff — an editor's unit is the frame, not the millisecond. */
export function formatTimecode(seconds: number, frameRate: number): string {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const frames = Math.floor((safe - whole) * frameRate);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frames).padStart(2, "0")}`;
}
