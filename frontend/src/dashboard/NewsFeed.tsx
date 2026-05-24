import React, { useState } from 'react';
import { Card } from '../ui/Card';
import { mockNews } from '../services/mockData';
import { Newspaper } from 'lucide-react';
import { NewsArchiveModal } from './NewsArchiveModal';

export const NewsFeed: React.FC = () => {
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);

  return (
    <>
      <Card 
        title="News Feed" 
        className="h-[300px] md:h-full"
        action={<Newspaper className="w-4 h-4 text-slate-400" />}
      >
        <div className="flex flex-col h-full">
          <div className="flex-1 space-y-4 overflow-y-auto">
            {mockNews.slice(0, 3).map((news) => (
              <div key={news.id} className="border-l-2 border-blue-500 pl-3 py-1">
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-xs text-blue-400 font-mono">{new Date(news.timestamp).toLocaleTimeString()}</span>
                </div>
                <h4 className="text-sm font-medium text-slate-200 leading-tight mb-1">{news.headline}</h4>
                <p className="text-xs text-slate-400 line-clamp-2">{news.summary}</p>
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