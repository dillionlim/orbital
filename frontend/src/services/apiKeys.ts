import { supabase } from '../lib/supabase';

const API_BASE_URL = '/api/backend';

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  userId: string;
  createdAt: Date;
}

// The backend guard reads the Supabase session from the
// `Authorization: Bearer <token>` header.
async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
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
