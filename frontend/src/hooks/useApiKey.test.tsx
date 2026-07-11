import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockApiKey {
  id: string;
  key: string;
  name: string;
  userId: string;
  createdAt: Date;
}

const mockAuth = vi.hoisted(() => ({
  current: { isLoaded: true, user: { id: 'user-1' } as { id: string } | null },
}));

const mockApiKeysService = vi.hoisted(() => ({
  getApiKeys: vi.fn<() => Promise<MockApiKey[]>>(),
  createApiKey: vi.fn<() => Promise<MockApiKey>>(),
}));

vi.mock('../lib/auth', () => ({
  useUser: () => mockAuth.current,
}));

vi.mock('../services/apiKeys', () => ({
  apiKeysService: mockApiKeysService,
}));

import { useApiKey } from './useApiKey';

function apiKey(key: string): MockApiKey {
  return {
    id: key,
    key,
    name: 'Default API Key',
    userId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('useApiKey', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuth.current = { isLoaded: true, user: { id: 'user-1' } };
    mockApiKeysService.getApiKeys.mockReset();
    mockApiKeysService.createApiKey.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // Confirms backend state wins over the optimistic local cache after mount.
  it('reconciles a cached key with the backend key', async () => {
    localStorage.setItem('apiKey', 'sk_live_cached');
    mockApiKeysService.getApiKeys.mockResolvedValue([apiKey('sk_live_backend')]);

    const { result } = renderHook(() => useApiKey());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.apiKey).toBe('sk_live_backend');
    expect(result.current.error).toBeNull();
    expect(localStorage.getItem('apiKey')).toBe('sk_live_backend');
  });

  // Keeps the UI usable during backend failures by retaining the cached key.
  it('keeps the cached key and surfaces an error when backend lookup fails', async () => {
    localStorage.setItem('apiKey', 'sk_live_cached');
    mockApiKeysService.getApiKeys.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useApiKey());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.apiKey).toBe('sk_live_cached');
    expect(result.current.error).toBe('network down');
    expect(localStorage.getItem('apiKey')).toBe('sk_live_cached');
  });

  // Exercises the explicit user action that creates and caches a replacement key.
  it('generates and stores a new API key on request', async () => {
    mockApiKeysService.getApiKeys.mockResolvedValue([]);
    mockApiKeysService.createApiKey.mockResolvedValue(apiKey('sk_live_generated'));
    const { result } = renderHook(() => useApiKey());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await expect(result.current.generateApiKey()).resolves.toBe('sk_live_generated');
    });

    expect(result.current.apiKey).toBe('sk_live_generated');
    expect(localStorage.getItem('apiKey')).toBe('sk_live_generated');
  });
});
