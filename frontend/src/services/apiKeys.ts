const API_BASE_URL = '/api/backend';

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  userId: string;
  createdAt: Date;
}

// The backend's ClerkAuthGuard reads the Clerk session from the
// `Authorization: Bearer <token>` header. These calls run outside React, so we
// reach the active session through Clerk's global rather than a hook.
async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (
    globalThis as unknown as {
      Clerk?: { session?: { getToken?: () => Promise<string | null> } };
    }
  ).Clerk;
  const token = await clerk?.session?.getToken?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const apiKeysService = {
  async getApiKeys(): Promise<ApiKey[]> {
    const response = await fetch(`${API_BASE_URL}/api-keys`, {
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to fetch API keys');
    }

    return response.json();
  },

  async createApiKey(name: string = 'Default API Key'): Promise<ApiKey> {
    const response = await fetch(`${API_BASE_URL}/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      body: JSON.stringify({ name }),
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to create API key');
    }

    return response.json();
  },

  async deleteApiKey(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/api-keys/${id}`, {
      method: 'DELETE',
      headers: {
        ...(await authHeaders()),
      },
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to delete API key');
    }
  },
};
