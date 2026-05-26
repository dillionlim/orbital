import React, { useEffect, useState, useCallback } from 'react';
import { Card } from '../ui/Card';
import { generateOrderBook } from '../services/mockData';
import { Order } from '../types';
import { useApiKey } from '../hooks/useApiKey';

interface OrderBookData {
  bids: Order[];
  asks: Order[];
  symbol: string;
  timestamp: string;
}

export const OrderBook: React.FC = () => {
  const [bids, setBids] = useState<Order[]>([]);
  const [asks, setAsks] = useState<Order[]>([]);
  const [filter, setFilter] = useState('');
  const [symbol, setSymbol] = useState('BTC-USD');
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { apiKey, isLoading: isApiKeyLoading, createApiKey, hasApiKey, refreshApiKey, clearApiKey } = useApiKey();

  const fetchOrderBook = useCallback(async () => {
    const currentServer = localStorage.getItem('currentServer') || 'localhost:9090';
    const [host, port] = currentServer.split(':');
    const symbolParam = symbol.split('-')[0].toLowerCase();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['Api-Key'] = apiKey;
      }

      const response = await fetch(`http://${host}:${port}/orderbook?symbol=${symbolParam}`, {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 401) {
        console.log('API Key unauthorized, refreshing...');
        clearApiKey();
        refreshApiKey();
        return;
      }

      if (response.ok) {
        const data: OrderBookData = await response.json();
        setBids(data.bids || []);
        setAsks(data.asks || []);
        setLastUpdate(data.timestamp || new Date().toISOString());
        setError(null);
      } else {
        throw new Error('Failed to fetch order book');
      }
    } catch {
      const mockData = generateOrderBook();
      setBids(mockData.bids);
      setAsks(mockData.asks);
      setLastUpdate(new Date().toISOString());
      setError(null);
    } finally {
      setIsLoading(false);
    }
  }, [symbol, apiKey]);

  useEffect(() => {
    if (!isApiKeyLoading) {
      setIsLoading(true);
      fetchOrderBook();
    }
  }, [fetchOrderBook, isApiKeyLoading]);

  useEffect(() => {
    if (!isApiKeyLoading && !hasApiKey) {
      createApiKey();
    }
  }, [isApiKeyLoading, hasApiKey, createApiKey]);

  useEffect(() => {
    const interval = setInterval(fetchOrderBook, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [fetchOrderBook]);

  const maxTotal = Math.max(
    bids.reduce((acc, curr) => acc + curr.size * curr.price, 0),
    asks.reduce((acc, curr) => acc + curr.size * curr.price, 0)
  );

  const filteredBids = bids.filter(bid => 
    !filter || (bid.price.toString().includes(filter) || bid.size.toString().includes(filter))
  );

  const filteredAsks = asks.filter(ask => 
    !filter || (ask.price.toString().includes(filter) || ask.size.toString().includes(filter))
  );

  return (
    <Card 
      title="Order Book" 
      action={
        <select 
          title="Select Market" 
          className="bg-slate-700 text-xs text-white border-none rounded px-2 py-1 outline-none"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        >
          <option>BTC-USD</option>
          <option>ETH-USD</option>
          <option>LTC-USD</option>
        </select>
      }
    >
      <div className="flex flex-col h-full">
        {isApiKeyLoading ? (
          <div className="text-xs text-slate-500 mb-2 px-2">Initializing authentication...</div>
        ) : error ? (
          <div className="text-xs text-yellow-500 mb-2 px-2">
            {error}
          </div>
        ) : null}
        {!isLoading && lastUpdate && (
          <div className="text-xs text-slate-500 mb-2 px-2">
            Last update: {new Date(parseInt(lastUpdate) || Date.now()).toLocaleTimeString()}
          </div>
        )}
        <div className="mb-3">
          <input 
            type="text" 
            placeholder="Filter orders..." 
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-white focus:border-blue-500 outline-none"
          />
        </div>
        
        {/* Headers */}
        <div className="flex border-b border-slate-800 text-[10px] uppercase text-slate-400 font-semibold mb-1">
          <div className="w-1/2 grid grid-cols-[0.8fr_1fr_1fr] gap-1 px-2 py-1 border-r border-slate-800">
            <span className="text-right">Size</span>
            <span className="text-right">Price</span>
            <span className="text-right">Total</span>
          </div>
          <div className="w-1/2 grid grid-cols-[1fr_0.8fr_1fr] gap-1 px-2 py-1">
            <span className="text-left">Price</span>
            <span className="text-left">Size</span>
            <span className="text-left">Total</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto flex text-[10px] font-mono tabular-nums tracking-tight">
          {/* Bids */}
          <div className="w-1/2 border-r border-slate-800">
            {isLoading ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                Loading...
              </div>
            ) : filteredBids.length === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                No bids
              </div>
            ) : (
              filteredBids.map((bid, i) => (
                <div key={`bid-${i}`} className="grid grid-cols-[0.8fr_1fr_1fr] gap-1 px-1 py-0.5 hover:bg-green-900/20 cursor-pointer relative">
                  <div className="absolute top-0 right-0 h-full bg-green-900/20" style={{ width: `${maxTotal > 0 ? ((bid.size * bid.price) / maxTotal) * 100 : 0}%` }} />
                  <span className="text-right text-slate-300 truncate relative z-10">{bid.size.toFixed(3)}</span>
                  <span className="text-right text-green-500 font-bold relative z-10">{bid.price.toFixed(1)}</span>
                  <span className="text-right text-slate-500 relative z-10">{(bid.size * bid.price / 1000).toFixed(1)}k</span>
                </div>
              ))
            )}
          </div>

          {/* Asks */}
          <div className="w-1/2">
            {isLoading ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                Loading...
              </div>
            ) : filteredAsks.length === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                No asks
              </div>
            ) : (
              filteredAsks.map((ask, i) => (
                <div key={`ask-${i}`} className="grid grid-cols-[1fr_0.8fr_1fr] gap-1 px-1 py-0.5 hover:bg-red-900/20 cursor-pointer relative">
                  <div className="absolute top-0 left-0 h-full bg-red-900/20" style={{ width: `${maxTotal > 0 ? ((ask.size * ask.price) / maxTotal) * 100 : 0}%` }} />
                  <span className="text-left text-red-500 font-bold relative z-10">{ask.price.toFixed(1)}</span>
                  <span className="text-left text-slate-300 truncate relative z-10">{ask.size.toFixed(3)}</span>
                  <span className="text-left text-slate-500 relative z-10">{(ask.size * ask.price / 1000).toFixed(1)}k</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Card>
  );
};