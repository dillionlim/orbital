import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVER } from '../services/engineUrl';
import { setCurrentServer, useCurrentServer } from './useCurrentServer';

const STORAGE_KEY = 'currentServer';

// Fires the event the browser would fire in *another* tab: localStorage's native
// `storage` event never fires in the tab that wrote the value.
function crossTabWrite(key: string, value: string): void {
  localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
}

describe('useCurrentServer', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  // A fresh browser has no selection yet, so widgets must land on the build-time
  // default rather than an undefined host.
  it('falls back to the default server when nothing is stored', () => {
    const { result } = renderHook(() => useCurrentServer());

    expect(result.current).toBe(DEFAULT_SERVER);
  });

  // A returning user's selection is read synchronously on mount — no flash of the
  // default server (which would fetch the wrong engine for one render).
  it('reads the stored server on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'engine.local:9090');

    const { result } = renderHook(() => useCurrentServer());

    expect(result.current).toBe('engine.local:9090');
  });

  // The cross-server data-leak guard: writing through setCurrentServer must reach
  // *every* live consumer in the same tab, not just the component that switched.
  // A naive localStorage.setItem would leave these widgets on the old engine.
  it('broadcasts a same-tab switch to every mounted consumer', () => {
    const first = renderHook(() => useCurrentServer());
    const second = renderHook(() => useCurrentServer());

    act(() => setCurrentServer('engine.b:9090'));

    expect(first.result.current).toBe('engine.b:9090');
    expect(second.result.current).toBe('engine.b:9090');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('engine.b:9090');
  });

  // Two tabs on the same dashboard: the other tab only gets a `storage` event, so
  // the hook has to re-read localStorage from that listener as well.
  it('picks up a cross-tab switch from the storage event', () => {
    const { result } = renderHook(() => useCurrentServer());

    act(() => crossTabWrite(STORAGE_KEY, 'engine.other-tab:9090'));

    expect(result.current).toBe('engine.other-tab:9090');
  });

  // …but only for its own key. Unrelated writes (the API key, onboarding flags)
  // share the storage event and must not churn the server or trigger refetches.
  it('ignores storage events for other keys', () => {
    localStorage.setItem(STORAGE_KEY, 'engine.local:9090');
    const { result } = renderHook(() => useCurrentServer());

    act(() => crossTabWrite('apiKey', 'sk_live_something_else'));

    expect(result.current).toBe('engine.local:9090');
  });

  // A cross-tab clear (user signed out elsewhere) re-reads an empty value and
  // resolves to the default rather than an empty host string.
  it('falls back to the default when a cross-tab write clears the key', () => {
    localStorage.setItem(STORAGE_KEY, 'engine.local:9090');
    const { result } = renderHook(() => useCurrentServer());

    act(() => {
      localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null }));
    });

    expect(result.current).toBe(DEFAULT_SERVER);
  });

  // Unmounted widgets must stop listening, or every dashboard remount leaks a
  // listener that setStates into a dead tree.
  it('removes both listeners on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useCurrentServer());

    unmount();

    const removed = remove.mock.calls.map(([event]) => event);
    expect(removed).toContain('bubbles:currentServer');
    expect(removed).toContain('storage');
    remove.mockRestore();
  });
});
