export interface TourStep {
  id: string;
  title: string;
  body: string;
  target?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Bubbles',
    body:
      'Bubbles is a live trading sandbox: you point it at a matching engine, run strategy ' +
      'bots against it, and watch the fills land in real time. Here is a quick tour of ' +
      'the dashboard.',
  },
  {
    id: 'nav',
    title: 'Getting around',
    body:
      'Dashboard is this live view. Config generates a ready-to-run bot config file, and ' +
      'Docs has the full API reference for writing your own strategies.',
    target: '[data-tour="nav"]',
    placement: 'bottom',
  },
  {
    id: 'server',
    title: 'Pick your engine',
    body:
      'Every widget below reads from the server selected here. Add your own engine with the ' +
      '+ button; the Wi-Fi icon turns green once Bubbles can reach it.',
    target: '[data-tour="server"]',
    placement: 'bottom',
  },
  {
    id: 'apikey',
    title: 'Your API key',
    body:
      'Bots authenticate with this key when they place orders. Click to reveal or copy it. ' +
      'You will paste it into your bot config.',
    target: '[data-tour="apikey"]',
    placement: 'bottom',
  },
  {
    id: 'orderbook',
    title: 'Order book',
    body:
      'The live bid/ask ladder for the selected market. Switch markets from the dropdown in ' +
      'its header, and the trade feeds below follow your selection.',
    target: '[data-tour="orderbook"]',
    placement: 'right',
  },
  {
    id: 'bots',
    title: 'Your strategy nodes',
    body:
      'Every bot you have connected shows up here with its live PnL. Start and stop them ' +
      'from this panel. A bot only trades while it is running.',
    target: '[data-tour="bots"]',
    placement: 'left',
  },
  {
    id: 'news',
    title: 'News feed',
    body:
      'Market headlines as they break. Bots can subscribe to the same feed and trade the ' +
      'sentiment, which is what makes the simulated market move.',
    target: '[data-tour="news"]',
    placement: 'left',
  },
  {
    id: 'pnl',
    title: 'Your PnL',
    body:
      'Realized PnL for your bots over time. The chart just above it tracks ' +
      'index returns, so you can see whether you beat the market or just rode it.',
    target: '[data-tour="pnl"]',
    placement: 'top',
  },
  {
    id: 'trades',
    title: 'Trade feeds',
    body:
      'Every fill on the engine, the outsized ones worth noticing, and, on the right, just ' +
      'your own trades.',
    target: '[data-tour="trades"]',
    placement: 'top',
  },
  {
    id: 'backtester',
    title: 'Backtester',
    body:
      'Write a strategy in Python and run it against historical data before you risk it live. ' +
      'It runs in your browser, so nothing leaves the page.',
    target: '[data-tour="backtester"]',
    placement: 'top',
  },
  {
    id: 'done',
    title: "That's the tour",
    body:
      'Next step: generate an API key, grab a config from the Config tab, and point a bot at ' +
      'your engine. You can replay this walkthrough any time from the account menu in the ' +
      'top-right.',
  },
];
