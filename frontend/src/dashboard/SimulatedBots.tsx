import React, { useState } from 'react';
import { Card } from '../ui/Card';
import { Play, Pause, Trash2, Info } from 'lucide-react';
import { initialBots } from '../services/mockData';
import { BotStrategy } from '../types';

export const SimulatedBots: React.FC = () => {
  const [bots, setBots] = useState<BotStrategy[]>(initialBots);

  const toggleBot = (id: string) => {
    setBots(bots.map(bot => 
      bot.id === id ? { ...bot, status: bot.status === 'active' ? 'paused' : 'active' } : bot
    ));
  };

  const deleteBot = (id: string) => {
    setBots(bots.filter(b => b.id !== id));
  };

  return (
    <Card title="Active Strategy Nodes" className="h-[300px] md:h-full">
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead className="text-[10px] uppercase text-slate-400 bg-slate-900/50 sticky top-0">
              <tr>
                <th className="px-3 py-2 font-medium whitespace-nowrap">Bot ID</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">Strategy</th>
                <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Total PnL</th>
                <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Hr PnL</th>
                <th className="px-3 py-2 font-medium text-center whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody className="text-sm divide-y divide-slate-800">
              {bots.map((bot) => (
                <tr key={bot.id} className="group hover:bg-slate-700/30 transition-colors">
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${bot.status === 'active' ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                      <span className="font-medium text-white">{bot.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{bot.strategyName}</td>
                  <td className={`px-3 py-2 text-right font-mono ${bot.totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {bot.totalPnL > 0 ? '+' : ''}{bot.totalPnL}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono text-xs ${bot.hourlyPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {bot.hourlyPnL > 0 ? '+' : ''}{bot.hourlyPnL}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button 
                        onClick={() => toggleBot(bot.id)}
                        className={`p-1.5 rounded transition-colors ${bot.status === 'active' ? 'bg-green-900/30 text-green-400 hover:bg-green-900/50' : 'bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/50'}`}
                        title={bot.status === 'active' ? 'Pause' : 'Resume'}
                      >
                        {bot.status === 'active' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      </button>
                      <button 
                        onClick={() => deleteBot(bot.id)}
                        className="p-1.5 hover:bg-red-900/50 rounded text-slate-500 hover:text-red-400 transition-colors"
                        title="Remove Bot"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {bots.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-slate-500 text-sm">
                    No active bots connected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        
        <div className="mt-2 py-2 border-t border-slate-700 flex justify-center items-center gap-2 text-xs text-slate-500">
          <Info className="w-3.5 h-3.5" />
          Connect external engines via API to add new strategies.
        </div>
      </div>
    </Card>
  );
};