import React from 'react';

interface CardProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({ title, children, className = '', action }) => {
  return (
    <div className={`bg-slate-800 border border-slate-700 rounded-lg shadow-sm flex flex-col overflow-hidden ${className}`}>
      {title && (
        <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center">
          <h3 className="font-semibold text-slate-200">{title}</h3>
          {action && <div>{action}</div>}
        </div>
      )}
      <div className="p-4 flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
};