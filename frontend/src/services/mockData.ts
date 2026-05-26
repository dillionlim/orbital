import { Trade, Order, BotStrategy, NewsItem, ChartPoint } from '../types';

export const generateTrade = (): Trade => {
    return {
        id: Math.random().toString(36).substring(7),
        time: new Date().toISOString(),
        instrument: 'BTC-USD',
        price: 50000 + Math.random() * 1000,
        volume: Math.random() * 2,
        aggressor: Math.random() > 0.5 ? 'Buyer' : 'Seller'
    };
};

export const generateOrderBook = (): { bids: Order[], asks: Order[] } => {
    const bids: Order[] = [];
    const asks: Order[] = [];
    for (let i = 0; i < 10; i++) {
        bids.push({
            price: 49000 + i * 10,
            size: Math.random() * 5,
            total: Math.random() * 50000
        });
        asks.push({
            price: 50000 + i * 10,
            size: Math.random() * 5,
            total: Math.random() * 50000
        });
    }
    return { bids, asks };
};

export const initialBots: BotStrategy[] = [
    {
        id: '1',
        name: 'Bot 1',
        strategyName: 'Moving Average Crossover',
        totalPnL: 1500,
        hourlyPnL: 50,
        status: 'active'
    },
    {
        id: '2',
        name: 'Bot 2',
        strategyName: 'Mean Reversion',
        totalPnL: -200,
        hourlyPnL: -10,
        status: 'paused'
    }
];

export const mockNews: NewsItem[] = [
    {
        id: '1',
        timestamp: new Date().toISOString(),
        headline: 'Bitcoin Reaches New High',
        summary: 'Bitcoin prices have surged past $60,000...'
    },
    {
        id: '2',
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        headline: 'Market Volatility Increases',
        summary: 'Traders are seeing increased volatility...'
    },
    {
        id: '3',
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        headline: 'Ethereum Upgrade Successful',
        summary: 'The latest Ethereum upgrade has been successfully deployed...'
    },
    {
        id: '4',
        timestamp: new Date(Date.now() - 10800000).toISOString(),
        headline: 'New DeFi Protocol Launched',
        summary: 'A new decentralized finance protocol has been launched on the Avalanche network...'
    },
    {
        id: '5',
        timestamp: new Date(Date.now() - 14400000).toISOString(),
        headline: 'Regulatory News Shakes Markets',
        summary: 'New regulations are being proposed that could impact the cryptocurrency market...'
    },
    {
        id: '6',
        timestamp: new Date(Date.now() - 18000000).toISOString(),
        headline: 'NFT Market Sees Resurgence',
        summary: 'The NFT market is showing signs of a comeback...'
    }
];

export const generateMultiSeriesChartData = (): ChartPoint[] => {
    const data: ChartPoint[] = [];
    const now = Date.now();
    for (let i = 0; i < 24; i++) {
        data.push({
            time: new Date(now - (24 - i) * 3600000).toLocaleTimeString(),
            value: 1000 + Math.random() * 500,
            name: 'Strategy 1'
        });
        data.push({
            time: new Date(now - (24 - i) * 3600000).toLocaleTimeString(),
            value: 800 + Math.random() * 400,
            name: 'Strategy 2'
        });
    }
    return data;
};
