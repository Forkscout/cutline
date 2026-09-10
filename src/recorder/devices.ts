/**
 * Device lists, and the permission dance they require.
 *
 * `enumerateDevices` returns entries with empty `label` strings until the
 * origin has been granted camera/mic access at least once — so a device picker
 * shown before priming is a list of blanks. `primePermissions` takes the grant,
 * then immediately drops the tracks: we want the permission, not the stream.
 */

export interface DeviceOption {
  deviceId: string;
  label: string;
  groupId: string;
}

function toOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind): DeviceOption[] {
  return devices
    .filter((d) => d.kind === kind)
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${i + 1}`,
      groupId: d.groupId,
    }));
}

export interface DeviceLists {
  cameras: DeviceOption[];
  microphones: DeviceOption[];
  /** True when labels came back blank, meaning permission has not been primed. */
  needsPermission: boolean;
}

export async function listDevices(): Promise<DeviceLists> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = toOptions(devices, "videoinput");
  const microphones = toOptions(devices, "audioinput");
  const anyInputs = devices.some((d) => d.kind === "videoinput" || d.kind === "audioinput");
  const anyLabels = devices.some(
    (d) => (d.kind === "videoinput" || d.kind === "audioinput") && d.label !== "",
  );
  return { cameras, microphones, needsPermission: anyInputs && !anyLabels };
}

/**
 * Ask for camera and mic once so the device labels resolve. Each is asked for
 * separately: a machine with a mic but no camera should still end up with a
 * usable microphone list rather than one failed combined request.
 */
export async function primePermissions(): Promise<{ camera: boolean; microphone: boolean }> {
  const result = { camera: false, microphone: false };
  for (const [key, constraints] of [
    ["camera", { video: true }],
    ["microphone", { audio: true }],
  ] as const) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((t) => t.stop());
      result[key] = true;
    } catch {
      // A refusal or an absent device are the same thing to the caller: no list.
    }
  }
  return result;
}

/** Fires when devices are plugged in or removed. Returns an unsubscribe. */
export function onDeviceChange(handler: () => void): () => void {
  navigator.mediaDevices.addEventListener("devicechange", handler);
  return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
}
