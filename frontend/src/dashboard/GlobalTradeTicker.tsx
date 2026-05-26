import React, { useEffect, useState, useRef } from 'react';
import { Card } from '../ui/Card';
import { Trade } from '../types';
import { generateTrade } from '../services/mockData';

export const GlobalTradeTicker: React.FC = () => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [filter, setFilter] = useState('');
  const tradeIdRef = useRef(0);

  useEffect(() => {
    // Fill initial
    const initialTrades = Array.from({ length: 15 }).map(() => {
      tradeIdRef.current++;
      return generateTrade();
    });
    setTrades(initialTrades);

    // Stream
    const interval = setInterval(() => {
      tradeIdRef.current++;
      const newTrade = generateTrade();
      setTrades(prev => [newTrade, ...prev].slice(0, 50)); // Keep last 50
    }, 800);

    return () => clearInterval(interval);
  }, []);

  const filteredTrades = trades.filter(trade => 
    trade.instrument.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <Card title="Global Trade Ticker" className="h-[350px]">
      <div className="flex flex-col h-full">
        <div className="mb-3">
           <input 
              type="text" 
              placeholder="Filter trades by instrument..." 
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-white focus:border-blue-500 outline-none"
            />
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead className="text-[10px] uppercase text-slate-400 bg-slate-800 sticky top-0">
              <tr>
                <th className="px-2 py-1.5">Time</th>
                <th className="px-2 py-1.5">Inst</th>
                <th className="px-2 py-1.5 text-right">Price</th>
                <th className="px-2 py-1.5 text-right">Vol</th>
                <th className="px-2 py-1.5 text-right">Aggressor</th>
              </tr>
            </thead>
            <tbody className="text-xs font-mono divide-y divide-slate-800/50">
              {filteredTrades.map((trade) => (
                <tr key={trade.id} className="hover:bg-slate-700/30">
                  <td className="px-2 py-1 text-slate-400">{trade.time}</td>
                  <td className="px-2 py-1 text-blue-400">{trade.instrument}</td>
                  <td className={`px-2 py-1 text-right ${trade.aggressor === 'Buyer' ? 'text-green-500' : 'text-red-500'}`}>
                    {trade.price.toFixed(1)}
                  </td>
                  <td className="px-2 py-1 text-right text-slate-300">{trade.volume.toFixed(4)}</td>
                  <td className={`px-2 py-1 text-right ${trade.aggressor === 'Buyer' ? 'text-green-400' : 'text-red-400'}`}>
                    {trade.aggressor}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
};