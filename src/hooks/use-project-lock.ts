import { useCallback, useEffect, useRef, useState } from "react";

type Message =
  | { type: "claim"; tab: string }
  | { type: "held"; tab: string }
  | { type: "takeover"; tab: string }
  | { type: "release"; tab: string };

/** How long to wait for another tab to answer before assuming we are alone. */
const CLAIM_TIMEOUT_MS = 350;

/**
 * One writer per project, across tabs.
 *
 * Autosave writes the whole document, so two tabs open on the same project
 * overwrite each other on every keystroke and the loser never finds out. This
 * gives the second tab a way to know — it opens read-only and says so — and a
 * deliberate way to take over.
 *
 * A `BroadcastChannel` is the right size for this: same-origin, no server, and
 * it dies with the tab, so a crashed holder does not leave a stale lock behind.
 */
export function useProjectLock(projectId: string) {
  const [isPrimary, setPrimary] = useState(true);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tabId = useRef(crypto.randomUUID());
  const primaryRef = useRef(true);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(`cutline.project.${projectId}`);
    channelRef.current = channel;
    const me = tabId.current;
    let answered = false;

    const setBoth = (value: boolean) => {
      primaryRef.current = value;
      setPrimary(value);
    };

    channel.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      if (msg.tab === me) return;

      switch (msg.type) {
        case "claim":
          // Only the current holder answers, so a third tab hears one voice.
          if (primaryRef.current) channel.postMessage({ type: "held", tab: me } satisfies Message);
          break;
        case "held":
          answered = true;
          setBoth(false);
          break;
        case "takeover":
          setBoth(false);
          break;
        case "release":
          // The holder left. Whoever is still here can have it.
          setBoth(true);
          break;
      }
    };

    channel.postMessage({ type: "claim", tab: me } satisfies Message);
    const timer = window.setTimeout(() => {
      if (!answered) setBoth(true);
    }, CLAIM_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
      if (primaryRef.current) {
        channel.postMessage({ type: "release", tab: me } satisfies Message);
      }
      channel.close();
      channelRef.current = null;
    };
  }, [projectId]);

  const takeOver = useCallback(() => {
    channelRef.current?.postMessage({ type: "takeover", tab: tabId.current } satisfies Message);
    primaryRef.current = true;
    setPrimary(true);
  }, []);

  return { isPrimary, takeOver };
}
