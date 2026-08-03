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

export enum ConnectionStatus {
  CONNECTED = 'Connected',
  DISCONNECTED = 'Disconnected',
  CONNECTING = 'Connecting'
}