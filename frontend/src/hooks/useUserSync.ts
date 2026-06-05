'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect, useRef } from 'react';

// Module-scoped guard: dedupes across hot-reload + React Strict Mode double-mount
// + multiple component instances in the same tab. Set BEFORE the await so a
// second effect run doesn't slip past while the first fetch is still in flight.
let inFlight: Promise<void> | null = null;
let succeeded = false;

export function useUserSync() {
  const { isLoaded, userId, getToken } = useAuth();
  const lastSyncedUser = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !userId) return;
    // If we already synced this user successfully in this tab, do nothing —
    // the backend sync is idempotent now but a redundant network round trip
    // is still wasteful (and historically caused the parallel-POST race).
    if (succeeded && lastSyncedUser.current === userId) return;
    if (inFlight) return;

    inFlight = (async () => {
      try {
        const token = await getToken();
        const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3010';
        const response = await fetch(`${backendUrl}/users/sync`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        if (response.ok) {
          succeeded = true;
          lastSyncedUser.current = userId;
        } else {
          console.error('Failed to sync user', await response.text());
        }
      } catch (error) {
        console.error('Error syncing user:', error);
      } finally {
        inFlight = null;
      }
    })();
  }, [isLoaded, userId, getToken]);
}
