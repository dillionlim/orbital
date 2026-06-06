import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { newsService, NewsUnavailableError, type NewsArticle } from '../services/news';

interface NewsArchiveModalProps {
  onClose: () => void;
}

export const NewsArchiveModal: React.FC<NewsArchiveModalProps> = ({ onClose }) => {
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = await newsService.getLatest(200);
        if (!cancelled) {
          setNews(items);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof NewsUnavailableError) {
            setError('News service is temporarily unavailable. Try again shortly.');
          } else {
            setError(err instanceof Error ? err.message : 'Failed to load news');
          }
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-lg shadow-xl p-6 w-full max-w-2xl h-[80vh] flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">News Archive</h3>
          <button onClick={onClose} title="Close" className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-4">
          {isLoading && (
            <div className="text-xs text-slate-500">Loading…</div>
          )}
          {error && (
            <div className="text-xs text-red-400">{error}</div>
          )}
          {!isLoading && !error && news.length === 0 && (
            <div className="text-xs text-slate-500">No news available.</div>
          )}
          {news.map((item) => (
            <div key={item.id} className="border-l-2 border-blue-500 pl-3 py-1">
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-xs text-blue-400 font-mono">
                  {new Date(item.datetime).toLocaleString()}
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
              <p className="text-xs text-slate-400">{item.summary}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
