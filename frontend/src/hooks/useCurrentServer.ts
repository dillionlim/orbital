import { useEffect, useState } from 'react';
import { DEFAULT_SERVER } from '../services/engineUrl';

// Reactive accessor for the user-selected trading server.
//
// localStorage's native `storage` event only fires in *other* tabs, so we
// also broadcast a custom event for same-tab observers (the dashboard
// widgets). All writes should go through `setCurrentServer` below so the
// event always fires; raw `localStorage.setItem('currentServer', ...)`
// would silently bypass it and reintroduce the cross-server data leak.

const STORAGE_KEY = 'currentServer';
const EVENT = 'bubbles:currentServer';
const FALLBACK_SERVER = DEFAULT_SERVER;

function read(): string {
  if (typeof window === 'undefined') return FALLBACK_SERVER;
  return localStorage.getItem(STORAGE_KEY) || FALLBACK_SERVER;
}

export function setCurrentServer(server: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, server);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: server }));
}

export function useCurrentServer(): string {
  const [server, setServer] = useState<string>(() => read());
  useEffect(() => {
    const onCustom = (e: Event) => {
      const next = (e as CustomEvent<string>).detail || read();
      setServer(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setServer(read());
    };
    window.addEventListener(EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return server;
}
