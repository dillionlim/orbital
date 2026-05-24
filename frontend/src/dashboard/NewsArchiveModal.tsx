import React from 'react';
import { X } from 'lucide-react';
import { mockNews } from '../services/mockData';

interface NewsArchiveModalProps {
  onClose: () => void;
}

export const NewsArchiveModal: React.FC<NewsArchiveModalProps> = ({ onClose }) => {
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
          {mockNews.map((news) => (
            <div key={news.id} className="border-l-2 border-blue-500 pl-3 py-1">
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-xs text-blue-400 font-mono">{new Date(news.timestamp).toLocaleString()}</span>
              </div>
              <h4 className="text-sm font-medium text-slate-200 leading-tight mb-1">{news.headline}</h4>
              <p className="text-xs text-slate-400">{news.summary}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
