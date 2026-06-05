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

  useEffect(() => {
    if (!apiKey) {
      setStream(null);
      setStatus('closed');
      return;
    }
    const s = acquireStream(server, apiKey);
    setStream(s);
    const off = s.onStatus(setStatus);
    return () => {
      off();
      releaseStream(server, apiKey);
    };
  }, [apiKey, server]);

  return { stream, status };
}
