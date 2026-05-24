import React, { useEffect, useState, useRef } from 'react';
import { Card } from '../ui/Card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { generateMultiSeriesChartData, initialBots } from '../services/mockData';
import { Filter, ChevronDown, Check } from 'lucide-react';

const SERIES_COLORS: Record<string, string> = {
  'Total': '#3b82f6',     // Blue
  'Bot 1': '#10b981',     // Emerald
  'Bot 2': '#f59e0b',     // Amber
};

const DEFAULT_SERIES = ['Total', ...initialBots.map(b => b.name)];

export const PnLCharts: React.FC = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any[]>([]);
  // Default to showing all series
  const [visibleSeries, setVisibleSeries] = useState<string[]>(DEFAULT_SERIES);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Avoid synchronous state update directly inside effect
    const timeout = setTimeout(() => {
        const rawData = generateMultiSeriesChartData();
        
        // Pivot the data for Recharts (it expects { time, 'Bot 1': value, 'Bot 2': value })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pivoted: any = {};
        rawData.forEach(d => {
            if (!pivoted[d.time]) pivoted[d.time] = { time: d.time, Total: 0, TotalHourly: 0 };
            pivoted[d.time][d.name] = d.value;
            // Map 'Strategy X' to 'Bot X' if needed, or just use d.name if they match
            // Based on mockData.ts, it uses 'Strategy 1', 'Strategy 2'
            // But DEFAULT_SERIES uses bot.name ('Bot 1', 'Bot 2')
            if (d.name === 'Strategy 1') pivoted[d.time]['Bot 1'] = d.value;
            if (d.name === 'Strategy 2') pivoted[d.time]['Bot 2'] = d.value;
            
            pivoted[d.time].Total += d.value;
            pivoted[d.time].TotalHourly += (d.value / 24); // Mock hourly delta
        });
        
        setData(Object.values(pivoted));
    }, 0);

    const interval = setInterval(() => {
       // Mock data update - shift time and append new data point
       setData(prevData => {
           if (prevData.length === 0) return prevData;
           
           const lastTime = prevData[prevData.length - 1].time;
           // Parse time HH:mm
           const [hours, minutes] = lastTime.split(':').map(Number);
           const nextDate = new Date();
           nextDate.setHours(hours);
           nextDate.setMinutes(minutes + 30);
           const nextTime = `${String(nextDate.getHours()).padStart(2, '0')}:${String(nextDate.getMinutes()).padStart(2, '0')}`;

           // eslint-disable-next-line @typescript-eslint/no-explicit-any
           const newDataPoint: any = { time: nextTime, Total: 0, TotalHourly: 0 };
           // Generate somewhat random next values based on previous
           
           DEFAULT_SERIES.forEach(series => {
               if (series === 'Total') return;
               const prevVal = prevData[prevData.length - 1][series] || 5000;
               const change = (Math.random() - 0.5) * 200;
               const newVal = prevVal + change;
               newDataPoint[series] = newVal;
               newDataPoint.Total += newVal;
               newDataPoint.TotalHourly += (newVal / 24);
           });
           
           // Keep size roughly constant
           return [...prevData.slice(1), newDataPoint];
       });
    }, 1000); // Update every 1 second

    return () => {
        clearTimeout(timeout);
        clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    // Close dropdown when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleSeries = (series: string) => {
    setVisibleSeries(prev => 
      prev.includes(series) 
        ? prev.filter(s => s !== series)
        : [...prev, series]
    );
  };

  return (
    <Card className="col-span-1 lg:col-span-1 border-none bg-transparent shadow-none !p-0">
      
      {/* Filters Toolbar */}
      <div className="flex justify-between items-center mb-4 bg-slate-800/50 p-2 rounded-lg border border-slate-700/50">
        <div className="flex items-center gap-2 px-2 text-slate-400">
          <span className="text-xs font-medium uppercase tracking-wider">Performance Analytics</span>
        </div>
        
        <div className="relative" ref={filterRef}>
          <button 
            onClick={() => setIsFilterOpen(!isFilterOpen)}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border border-slate-700 hover:border-slate-500 rounded text-xs font-medium text-slate-200 transition-colors"
          >
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Select Strategies</span>
            <span className="bg-slate-700 text-slate-300 px-1.5 rounded-full text-[10px]">{visibleSeries.length}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${isFilterOpen ? 'rotate-180' : ''}`} />
          </button>

          {isFilterOpen && (
            <div className="absolute right-0 top-full mt-2 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20 overflow-hidden">
              <div className="p-2 space-y-1">
                {DEFAULT_SERIES.map(series => (
                  <button
                    key={series}
                    onClick={() => toggleSeries(series)}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-md transition-colors ${
                      visibleSeries.includes(series) ? 'bg-slate-700/50 text-white' : 'text-slate-400 hover:bg-slate-700/30'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div 
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: SERIES_COLORS[series] || '#cbd5e1' }}
                      />
                      <span>{series}</span>
                    </div>
                    {visibleSeries.includes(series) && <Check className="w-3.5 h-3.5 text-blue-400" />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Total PnL */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold text-slate-200">Total PnL</h3>
             <span className="text-xs font-bold text-green-400 bg-green-900/30 px-2 py-0.5 rounded">+12.4%</span>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis 
                  dataKey="time" 
                  stroke="#64748b" 
                  tick={{fontSize: 10}} 
                  tickLine={false}
                  axisLine={false}
                  interval={4}
                />
                <YAxis 
                  stroke="#64748b" 
                  tick={{fontSize: 10}} 
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={(val) => `${(val/1000).toFixed(0)}`}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '4px', fontSize: '12px' }}
                  itemStyle={{ fontSize: '12px', padding: 0 }}
                />
                {visibleSeries.map(series => (
                  <Line 
                    key={series}
                    type="monotone" 
                    dataKey={series} 
                    stroke={SERIES_COLORS[series] || '#cbd5e1'} 
                    strokeWidth={series === 'Total' ? 2 : 1.5}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Hourly PnL */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold text-slate-200">Hourly Performance</h3>
            <span className="text-xs text-slate-400">Last 24h</span>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis 
                  dataKey="time" 
                  stroke="#64748b" 
                  tick={{fontSize: 10}} 
                  tickLine={false}
                  axisLine={false}
                  interval={4}
                />
                <YAxis 
                  stroke="#64748b" 
                  tick={{fontSize: 10}} 
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  domain={['auto', 'auto']}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '4px', fontSize: '12px' }}
                  itemStyle={{ fontSize: '12px', padding: 0 }}
                />
                 {visibleSeries.map(series => (
                  <Line 
                    key={`${series}_Hourly`}
                    name={series}
                    type="step" 
                    dataKey={series === 'Total' ? 'TotalHourly' : series} 
                    stroke={SERIES_COLORS[series] || '#cbd5e1'} 
                    strokeWidth={2} 
                    dot={false} 
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </Card>
  );
};
