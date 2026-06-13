import { useEffect, useState } from 'react';
import { useApiKey } from './useApiKey';
import { useCurrentServer } from './useCurrentServer';
import { fetchEngineUserId } from '../services/engineMe';

// Returns the user_id the *engine* attributes to the current API key, or null
// if we don't have a key, the engine doesn't recognise us, or the call fails.
//
// This is what bot ownership comparisons should key off of — the engine's
// view of identity is independent of Clerk's, and only the engine knows the
// `user_id` it stamped onto resting orders.
export function useEngineUserId(): string | null {
  const server = useCurrentServer();
  const { apiKey } = useApiKey();
  const [userId, setUserId] = useState<string | null>(null);

  // Reset on (server, apiKey) change via React's "derived state during
  // render" pattern instead of a synchronous setState in an effect —
  // keeps us out of react-hooks/set-state-in-effect.
  const [tracked, setTracked] = useState({ server, apiKey });
  if (tracked.server !== server || tracked.apiKey !== apiKey) {
    setTracked({ server, apiKey });
    setUserId(null);
  }

  useEffect(() => {
    if (!apiKey) return;
    const ctrl = new AbortController();
    fetchEngineUserId(server, apiKey, ctrl.signal)
      .then(id => { if (!ctrl.signal.aborted) setUserId(id); })
      .catch(() => { if (!ctrl.signal.aborted) setUserId(null); });
    return () => ctrl.abort();
  }, [server, apiKey]);

  return userId;
}
