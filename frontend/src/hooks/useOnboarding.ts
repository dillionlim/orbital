'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '../lib/auth';

// Completion is stored per user id, so a second account on the same browser still
// gets its own walkthrough. Bumping the version replays the tour for everyone —
// use that when the dashboard changes enough that the old tour is misleading.
const VERSION = 'v1';
const key = (userId: string) => `bubbles_onboarding_${VERSION}:${userId}`;

// Lets the Header re-open the tour without owning its state. The tour only exists
// on the dashboard, so a replay requested from another page has no listener yet:
// the flag survives the navigation and is picked up when the tour mounts.
const REPLAY_EVENT = 'bubbles:replay-onboarding';
const REPLAY_FLAG = 'bubbles_replay_onboarding';

export function replayOnboarding(): void {
  try {
    sessionStorage.setItem(REPLAY_FLAG, '1');
  } catch {
    /* storage unavailable — the same-page event below still fires */
  }
  window.dispatchEvent(new Event(REPLAY_EVENT));
}

export function useOnboarding(): {
  isOpen: boolean;
  finish: () => void;
} {
  const { user, isLoaded } = useUser();
  const [isOpen, setIsOpen] = useState(false);

  // Auto-open exactly once per user: only when we know who they are and storage
  // says they have not seen it. Storage being unreadable (private mode, blocked
  // cookies) must not trap the user in a tour that reopens on every load, so we
  // treat a throwing read as "already seen".
  useEffect(() => {
    if (!isLoaded || !user) return;
    let due = false;
    try {
      // A replay requested from another page wins over the seen-flag.
      if (sessionStorage.getItem(REPLAY_FLAG)) {
        sessionStorage.removeItem(REPLAY_FLAG);
        due = true;
      } else {
        due = localStorage.getItem(key(user.id)) === null;
      }
    } catch {
      /* storage unavailable — stay quiet rather than replay on every load */
    }
    if (due) queueMicrotask(() => setIsOpen(true));
  }, [isLoaded, user]);

  useEffect(() => {
    const onReplay = () => {
      try {
        sessionStorage.removeItem(REPLAY_FLAG);
      } catch {
        /* nothing to clean up */
      }
      setIsOpen(true);
    };
    window.addEventListener(REPLAY_EVENT, onReplay);
    return () => window.removeEventListener(REPLAY_EVENT, onReplay);
  }, []);

  // Finishing and skipping are the same commitment: the user has been offered the
  // tour, so don't nag. The account menu is the way back in.
  const finish = useCallback(() => {
    setIsOpen(false);
    if (!user) return;
    try {
      localStorage.setItem(key(user.id), new Date().toISOString());
    } catch {
      /* storage unavailable — the tour just reappears next session */
    }
  }, [user]);

  return { isOpen, finish };
}
