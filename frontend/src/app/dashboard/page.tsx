"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { Header } from "@/src/dashboard/Header";
import { GlobalTradeTicker } from "@/src/dashboard/GlobalTradeTicker";
import { BigTrades } from "@/src/dashboard/BigTrades";
import { MyTrades } from "@/src/dashboard/MyTrades";
import { OrderBook } from "@/src/dashboard/OrderBook";
import { IndicesPanel } from "@/src/dashboard/IndicesPanel";
import { ReturnsChart } from "@/src/dashboard/ReturnsChart";
import { PnLCharts } from "@/src/dashboard/PnLCharts";
import { NewsFeed } from "@/src/dashboard/NewsFeed";
import { SimulatedBots } from "@/src/dashboard/SimulatedBots";
import { Backtester } from "@/src/dashboard/Backtester";

export default function Dashboard() {
  const { isLoaded, isSignedIn } = useUser();
  const router = useRouter();

  // Client-side guard backing up the route middleware: a signed-out user must
  // never see the dashboard. (Belt-and-suspenders, and it avoids a flash of
  // protected content while the middleware redirect is in flight.)
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/");
  }, [isLoaded, isSignedIn, router]);

  if (!isLoaded || !isSignedIn) {
    return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans selection:bg-blue-500/30">
      <Header />
      
      <main className="p-4 md:p-6 grid grid-cols-1 md:grid-cols-12 gap-6 max-w-[1920px] mx-auto">
        {/* Top Row: Order Book & Bots & News Feed */}
        <div className="col-span-1 md:col-span-5 lg:col-span-5 space-y-6">
          <OrderBook />
          <IndicesPanel />
        </div>
        
        <div className="col-span-1 md:col-span-4 lg:col-span-4">
          <SimulatedBots />
        </div>

        <div className="col-span-1 md:col-span-3 lg:col-span-3">
          <NewsFeed />
        </div>

        {/* Index returns (full width) */}
        <div className="col-span-1 md:col-span-12">
            <ReturnsChart />
        </div>

        {/* Middle Row: PnL Charts (Full Width) */}
        <div className="col-span-1 md:col-span-12">
            <PnLCharts />
        </div>

        {/* Trades row: global ticker · big trades · my trades */}
        <div className="col-span-1 md:col-span-4">
            <GlobalTradeTicker />
        </div>
        <div className="col-span-1 md:col-span-4">
            <BigTrades />
        </div>
        <div className="col-span-1 md:col-span-4">
            <MyTrades />
        </div>

        {/* Backtester (full width) */}
        <div className="col-span-1 md:col-span-12">
           <Backtester />
        </div>
      </main>
    </div>
  );
}
