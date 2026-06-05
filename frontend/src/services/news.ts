const API_BASE_URL = '/api/backend';

export interface NewsArticle {
  id: number;
  category: string;
  datetime: string;
  headline: string;
  image?: string | null;
  related: string;
  source: string;
  summary: string;
  url: string;
}

export class NewsUnavailableError extends Error {
  constructor(message = 'News service is temporarily unavailable') {
    super(message);
    this.name = 'NewsUnavailableError';
  }
}

export const newsService = {
  async getLatest(limit = 50): Promise<NewsArticle[]> {
    const response = await fetch(`${API_BASE_URL}/news?limit=${limit}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });

    if (response.status === 503) {
      throw new NewsUnavailableError();
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch news (${response.status})`);
    }

    return response.json();
  },
};
