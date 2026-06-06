import React, { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Newspaper } from 'lucide-react';
import { NewsArchiveModal } from './NewsArchiveModal';
import { newsService, NewsUnavailableError, type NewsArticle } from '../services/news';

export const NewsFeed: React.FC = () => {
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const items = await newsService.getLatest(20);
        if (!cancelled) {
          setNews(items);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof NewsUnavailableError) {
            setError('News service unavailable — retrying…');
          } else {
            setError(err instanceof Error ? err.message : 'Failed to load news');
          }
        }
      }
    };

    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <>
      <Card
        title="News Feed"
        className="h-[300px] md:h-full"
        action={<Newspaper className="w-4 h-4 text-slate-400" />}
      >
        <div className="flex flex-col h-full">
          <div className="flex-1 space-y-4 overflow-y-auto">
            {error && (
              <div className="text-xs text-red-400">{error}</div>
            )}
            {!error && news.length === 0 && (
              <div className="text-xs text-slate-500">No news available.</div>
            )}
            {news.slice(0, 3).map((item) => (
              <div key={item.id} className="border-l-2 border-blue-500 pl-3 py-1">
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-xs text-blue-400 font-mono">
                    {new Date(item.datetime).toLocaleTimeString()}
                  </span>
                  <span className="text-[10px] text-slate-500">{item.source}</span>
                </div>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-slate-200 leading-tight mb-1 hover:text-blue-300 block"
                >
                  {item.headline}
                </a>
                <p className="text-xs text-slate-400 line-clamp-2">{item.summary}</p>
              </div>
            ))}
          </div>
          <div className="text-center pt-2 mt-auto">
            <button
              onClick={() => setIsArchiveOpen(true)}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              View Archive
            </button>
          </div>
        </div>
      </Card>
      {isArchiveOpen && <NewsArchiveModal onClose={() => setIsArchiveOpen(false)} />}
    </>
  );
};
