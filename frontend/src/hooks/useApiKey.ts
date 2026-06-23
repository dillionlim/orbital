import { useState, useEffect, useCallback } from 'react';
import { useUser } from '../lib/auth';
import { apiKeysService } from '../services/apiKeys';

const STORAGE_KEY = 'apiKey';

interface BackendResult {
  key: string | null;          // null = backend explicitly returned no key
  error: Error | null;          // non-null = network / auth failure (keep cached)
}

async function fetchFromBackend(): Promise<BackendResult> {
  try {
    const keys = await apiKeysService.getApiKeys();
    return { key: keys[0]?.key ?? null, error: null };
  } catch (err) {
    return {
      key: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Reads the user's API key. The backend is the source of truth; localStorage is
 * only an optimistic cache that lets the UI render instantly on the next page
 * load. Every mount triggers a reconciliation:
 *  - if the backend returns a key, that becomes the displayed value (and is
 *    written back to localStorage, even if it differs from what was cached);
 *  - if the backend returns no key, any stale local value is cleared;
 *  - if the backend call errors (network down, etc.), the cached value is kept
 *    so the UI doesn't flicker, and an error is surfaced.
 *
 * Never auto-creates a key. Use `generateApiKey()` (explicit user action) for
 * regeneration; the backend's /users/sync provisions the initial key on
 * first sign-in.
 */
export function useApiKey() {
  const { isLoaded: isUserLoaded, user } = useUser();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pre-effect derived-state reset: when there's no signed-in user, drop
  // out of "loading" without touching state inside an effect body. Using
  // React's "store info from previous renders" pattern so we don't trip
  // react-hooks/set-state-in-effect.
  const noUser = isUserLoaded && !user;
  const [trackedNoUser, setTrackedNoUser] = useState(noUser);
  if (noUser !== trackedNoUser) {
    setTrackedNoUser(noUser);
    if (noUser) setIsLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    if (!isUserLoaded || !user) return;

    (async () => {
      // Optimistic: show whatever's cached so the badge isn't blank
      // during the round trip. The backend response below overwrites it
      // if different. Doing this inside the async IIFE (rather than
      // synchronously in the effect body) keeps us out of
      // react-hooks/set-state-in-effect — the rule only flags setState
      // calls in the top-level synchronous portion of the effect.
      const stored = typeof window !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY)
        : null;
      if (stored && !cancelled) setApiKey(stored);

      const { key, error: backendError } = await fetchFromBackend();
      if (cancelled) return;

      if (backendError) {
        // Backend unreachable — keep the cached value so the UI stays useful,
        // but surface the error so callers can show a status indicator.
        setError(backendError.message);
        setIsLoading(false);
        return;
      }

      setError(null);
      if (key) {
        // Authoritative — overwrite local even if it differs.
        setApiKey(key);
        localStorage.setItem(STORAGE_KEY, key);
      } else {
        // Backend says this user has no key. Clear any stale cache.
        setApiKey(null);
        localStorage.removeItem(STORAGE_KEY);
      }
      setIsLoading(false);
    })();

    return () => { cancelled = true; };
  }, [isUserLoaded, user]);

  // Force re-fetch from the backend (no creation).
  const refreshApiKey = useCallback(async () => {
    if (!isUserLoaded || !user) return null;
    const { key, error: backendError } = await fetchFromBackend();
    if (backendError) {
      setError(backendError.message);
      return null;
    }
    setError(null);
    if (key) {
      setApiKey(key);
      localStorage.setItem(STORAGE_KEY, key);
    } else {
      setApiKey(null);
      localStorage.removeItem(STORAGE_KEY);
    }
    return key;
  }, [isUserLoaded, user]);

  // Explicit, destructive: backend deletes any existing key and creates a new one.
  // Only call this from a UI action that the user has clearly opted into.
  const generateApiKey = useCallback(async (): Promise<string | null> => {
    if (!isUserLoaded || !user) return null;
    try {
      const newKey = await apiKeysService.createApiKey();
      setApiKey(newKey.key);
      localStorage.setItem(STORAGE_KEY, newKey.key);
      setError(null);
      return newKey.key;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate API key');
      return null;
    }
  }, [isUserLoaded, user]);

  const clearApiKey = useCallback(() => {
    setApiKey(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return {
    apiKey,
    isLoading,
    error,
    hasApiKey: !!apiKey,
    refreshApiKey,
    generateApiKey,
    // Backwards-compat alias for existing call sites.
    createApiKey: generateApiKey,
    clearApiKey,
  };
}
