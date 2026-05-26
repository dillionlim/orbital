const API_BASE_URL = '/api/backend';

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  userId: string;
  createdAt: Date;
}

export const apiKeysService = {
  async getApiKeys(): Promise<ApiKey[]> {
    const response = await fetch(`${API_BASE_URL}/api-keys`, {
      headers: {
        'Content-Type': 'application/json',
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
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to delete API key');
    }
  },
};
