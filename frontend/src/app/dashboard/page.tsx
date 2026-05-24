"use client";

import { useUser } from "@clerk/nextjs";
import { Header } from "@/src/dashboard/Header";
import { GlobalTradeTicker } from "@/src/dashboard/GlobalTradeTicker";
import { OrderBook } from "@/src/dashboard/OrderBook";
import { PnLCharts } from "@/src/dashboard/PnLCharts";
import { NewsFeed } from "@/src/dashboard/NewsFeed";
import { SimulatedBots } from "@/src/dashboard/SimulatedBots";
import { Backtester } from "@/src/dashboard/Backtester";

export default function Dashboard() {
  const { isLoaded } = useUser();

  if (!isLoaded) {
    return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans selection:bg-blue-500/30">
      <Header />
      
      <main className="p-4 md:p-6 grid grid-cols-1 md:grid-cols-12 gap-6 max-w-[1920px] mx-auto">
        {/* Top Row: Order Book & Bots & News Feed */}
        <div className="col-span-1 md:col-span-5 lg:col-span-5">
          <OrderBook />
        </div>
        
        <div className="col-span-1 md:col-span-4 lg:col-span-4">
          <SimulatedBots />
        </div>

        <div className="col-span-1 md:col-span-3 lg:col-span-3">
          <NewsFeed />
        </div>

        {/* Middle Row: PnL Charts (Full Width) */}
        <div className="col-span-1 md:col-span-12">
            <PnLCharts />
        </div>

        {/* Bottom Row: Ticker & Backtester */}
        <div className="col-span-1 md:col-span-5">
            <GlobalTradeTicker />
        </div>

        <div className="col-span-1 md:col-span-7">
           <Backtester />
        </div>
      </main>
    </div>
  );
}
