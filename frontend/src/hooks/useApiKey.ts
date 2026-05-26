import { useState, useEffect, useCallback } from 'react';
import { useUser } from '@clerk/nextjs';
import { apiKeysService, ApiKey } from '../services/apiKeys';

export function useApiKey() {
  const { isLoaded: isUserLoaded, user } = useUser();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchApiKey = async () => {
      if (!isUserLoaded || !user) {
        setIsLoading(false);
        return;
      }

      const storedKey = localStorage.getItem('apiKey');
      if (storedKey) {
        setApiKey(storedKey);
        setIsLoading(false);
        return;
      }

      try {
        const keys = await apiKeysService.getApiKeys();
        if (keys.length > 0) {
          const key = keys[0].key;
          setApiKey(key);
          localStorage.setItem('apiKey', key);
        }
      } catch (err) {
        setError('Failed to fetch API key');
      } finally {
        setIsLoading(false);
      }
    };

    fetchApiKey();
  }, [isUserLoaded, user]);

  const refreshApiKey = useCallback(async () => {
    if (!isUserLoaded || !user) return;

    try {
      const keys = await apiKeysService.getApiKeys();
      if (keys.length > 0) {
        const key = keys[0].key;
        setApiKey(key);
        localStorage.setItem('apiKey', key);
        return key;
      }
    } catch (err) {
      setError('Failed to refresh API key');
    }
    return null;
  }, [isUserLoaded, user]);

  const createApiKey = useCallback(async (): Promise<string | null> => {
    if (!isUserLoaded || !user) return null;

    try {
      const newKey = await apiKeysService.createApiKey();
      setApiKey(newKey.key);
      localStorage.setItem('apiKey', newKey.key);
      return newKey.key;
    } catch (err) {
      setError('Failed to create API key');
      return null;
    }
  }, [isUserLoaded, user]);

  const clearApiKey = useCallback(() => {
    setApiKey(null);
    localStorage.removeItem('apiKey');
  }, []);

  return {
    apiKey,
    isLoading,
    error,
    refreshApiKey,
    createApiKey,
    clearApiKey,
    hasApiKey: !!apiKey,
  };
}
