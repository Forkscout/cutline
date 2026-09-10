/**
 * Live level for one audio stream, plus the one fact that matters most: has
 * this source made any sound at all since we started watching.
 *
 * A recorder that captures silence and says nothing is the expensive failure —
 * you find out after the take, and the take is gone. So the meter reports
 * `silentFor`, and the UI turns it into a warning while there is still time to
 * fix the input.
 */

import { useEffect, useRef, useState } from "react";

export interface AudioLevel {
  /** 0..1, RMS mapped from -60 dBFS to 0 dBFS. */
  level: number;
  /** 0..1, decaying peak hold. */
  peak: number;
  /** True once anything above the noise floor has been heard. */
  everHeard: boolean;
  /** Milliseconds of continuous near-silence, reset by any real sound. */
  silentFor: number;
}

const FLOOR_DB = -60;
/** Below this counts as silence rather than quiet speech. */
const SILENCE_DB = -50;

function rmsToUnit(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  if (db <= FLOOR_DB) return 0;
  return Math.min(1, (db - FLOOR_DB) / -FLOOR_DB);
}

export function useAudioLevel(stream: MediaStream | null, active: boolean): AudioLevel {
  const [state, setState] = useState<AudioLevel>({
    level: 0,
    peak: 0,
    everHeard: false,
    silentFor: 0,
  });
  const peakRef = useRef(0);
  const heardRef = useRef(false);
  const silentSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream || !active || stream.getAudioTracks().length === 0) return;

    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    // Deliberately not connected to the destination: monitoring the microphone
    // through the speakers during a screen recording is a feedback loop.

    const buffer = new Float32Array(analyser.fftSize);
    let raf = 0;

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const v = buffer[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buffer.length);
      const level = rmsToUnit(rms);
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

      peakRef.current = Math.max(level, peakRef.current * 0.94);

      const now = performance.now();
      if (db > SILENCE_DB) {
        heardRef.current = true;
        silentSinceRef.current = null;
      } else if (silentSinceRef.current === null) {
        silentSinceRef.current = now;
      }

      setState({
        level,
        peak: peakRef.current,
        everHeard: heardRef.current,
        silentFor: silentSinceRef.current === null ? 0 : now - silentSinceRef.current,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      analyser.disconnect();
      void context.close();
    };
  }, [stream, active]);

  return state;
}
