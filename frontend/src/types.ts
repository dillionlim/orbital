export interface Order {
  price: number;
  size: number;
  total: number;
}

export interface Trade {
  id: string;
  time: string;
  instrument: string;
  price: number;
  volume: number;
  aggressor: 'Buyer' | 'Seller';
}

export interface BotStrategy {
  id: string;
  name: string;
  strategyName: string;
  totalPnL: number;
  hourlyPnL: number;
  status: 'active' | 'paused';
}

export interface NewsItem {
  id: string;
  timestamp: string;
  headline: string;
  summary: string;
}

export interface ChartPoint {
  time: string;
  value: number;
  name: string;
}

export enum ConnectionStatus {
  CONNECTED = 'Connected',
  DISCONNECTED = 'Disconnected',
  CONNECTING = 'Connecting'
}

export interface User {
  id: string;
  name: string;
  email: string;
  apiKey: string;
}