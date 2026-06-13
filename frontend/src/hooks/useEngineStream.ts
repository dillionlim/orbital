import { useEffect, useState } from 'react';
import {
  acquireStream,
  releaseStream,
  type EngineStream,
  type StreamStatus,
} from '../services/engineStream';
import { useApiKey } from './useApiKey';
import { useCurrentServer } from './useCurrentServer';

/**
 * Returns the shared EngineStream for the current server + API key, plus the
 * live connection status. Re-runs when either input changes; switching the
 * server in the Header will tear down the old socket and connect to the new
 * one (so consumers see status='closed' → 'connecting' → 'open' and a fresh
 * snapshot, with no leftover state from the previous server).
 *
 * Status semantics:
 *   - 'connecting' — initial state and during reconnect attempts
 *   - 'open'       — WS is connected; subscribers are live
 *   - 'closed'     — disconnected; reconnect scheduled. Callers should fall
 *                    back to REST polling here.
 */
export function useEngineStream() {
  const { apiKey } = useApiKey();
  const server = useCurrentServer();
  const [stream, setStream] = useState<EngineStream | null>(null);
  const [status, setStatus] = useState<StreamStatus>('closed');

  // Synchronous reset on (server, apiKey) change via the derived-state
  // pattern. The effect below then either no-ops (no key) or attaches a
  // fresh stream — neither of those calls setState in the effect body.
  const [tracked, setTracked] = useState({ server, apiKey });
  if (tracked.server !== server || tracked.apiKey !== apiKey) {
    setTracked({ server, apiKey });
    setStream(null);
    setStatus('closed');
  }

  useEffect(() => {
    if (!apiKey) return;
    const s = acquireStream(server, apiKey);
    // Defer to a microtask so this isn't a synchronous setState in the
    // effect body. The stream identity is stable across renders within
    // the same (server, apiKey) so the deferral doesn't race.
    queueMicrotask(() => setStream(s));
    const off = s.onStatus(setStatus);
    return () => {
      off();
      releaseStream(server, apiKey);
    };
  }, [apiKey, server]);

  return { stream, status };
}
