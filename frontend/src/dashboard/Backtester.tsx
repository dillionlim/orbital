import React, { useState } from 'react';
import { Card } from '../ui/Card';
import { Calendar, PlayCircle, ChevronDown } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { initialBots } from '../services/mockData';

// Minimal mock data for the backtest preview graph
const previewData = [
  { p: 100 }, { p: 120 }, { p: 110 }, { p: 140 }, { p: 130 }, { p: 170 }, { p: 180 }, { p: 160 }, { p: 190 }, { p: 210 }
];

export const Backtester: React.FC = () => {
  const [selectedStrategy, setSelectedStrategy] = useState(initialBots[0]?.id || '');

  return (
    <Card title="Backtesting Environment">
      <div className="flex flex-col h-full gap-4">
        
        {/* Controls */}
        <div className="flex flex-wrap items-end gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
          <div className="flex-1 min-w-[120px]">
             <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">Strategy</label>
             <div className="relative">
                <select 
                  title="Select Strategy"
                  value={selectedStrategy}
                  onChange={(e) => setSelectedStrategy(e.target.value)}
                  className="w-full appearance-none bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500"
                >
                  {initialBots.map(bot => (
                    <option key={bot.id} value={bot.id}>{bot.name} - {bot.strategyName}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-2 w-3 h-3 text-slate-400 pointer-events-none" />
             </div>
          </div>

          <div className="flex-1 min-w-[100px]">
            <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">Start Date</label>
            <div className="flex items-center bg-slate-800 border border-slate-700 rounded px-2 py-1.5">
              <Calendar className="w-3.5 h-3.5 text-slate-400 mr-2" />
              <input type="text" title="Start Date" defaultValue="2023-01-01" className="bg-transparent border-none text-xs text-white outline-none w-full" />
            </div>
          </div>
          <div className="flex-1 min-w-[100px]">
            <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">End Date</label>
            <div className="flex items-center bg-slate-800 border border-slate-700 rounded px-2 py-1.5">
              <Calendar className="w-3.5 h-3.5 text-slate-400 mr-2" />
              <input type="text" title="End Date" defaultValue="2023-06-30" className="bg-transparent border-none text-xs text-white outline-none w-full" />
            </div>
          </div>
          <button className="flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 text-white rounded px-4 py-1.5 text-xs font-bold transition-colors h-[34px]">
            <PlayCircle className="w-3.5 h-3.5 mr-1.5" />
            Run Test
          </button>
        </div>

        {/* Results Preview */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 bg-slate-900/30 rounded border border-slate-700/30 relative overflow-hidden">
             <div className="absolute top-2 left-2 z-10 text-[10px] text-slate-500 font-mono">Equity Curve Preview</div>
             <ResponsiveContainer width="100%" height="100%">
               <AreaChart data={previewData}>
                 <defs>
                   <linearGradient id="colorPv" x1="0" y1="0" x2="0" y2="1">
                     <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                     <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                   </linearGradient>
                 </defs>
                 <Area type="monotone" dataKey="p" stroke="#6366f1" fillOpacity={1} fill="url(#colorPv)" strokeWidth={2} />
               </AreaChart>
             </ResponsiveContainer>
          </div>
          
          <div className="flex flex-col gap-2 justify-center">
             <div className="bg-slate-800 p-3 rounded border border-slate-700">
               <div className="text-[10px] text-slate-400 uppercase">Sharpe Ratio</div>
               <div className="text-lg font-mono text-white">2.45</div>
             </div>
             <div className="bg-slate-800 p-3 rounded border border-slate-700">
               <div className="text-[10px] text-slate-400 uppercase">Max Drawdown</div>
               <div className="text-lg font-mono text-red-400">-12.3%</div>
             </div>
             <div className="mt-auto p-2 bg-slate-800/50 rounded border border-dashed border-slate-700 text-center">
               <span className="text-[10px] text-slate-500">Select a connected strategy to begin analysis.</span>
             </div>
          </div>
        </div>

      </div>
    </Card>
  );
};