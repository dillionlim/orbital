'use client';

import React from 'react';
import { TrendingUp, Shield, Zap, ArrowRight, Activity } from 'lucide-react';
import { SignInButton, useUser } from '@clerk/nextjs';
import Link from 'next/link';

export default function LandingPage() {
  const { isSignedIn } = useUser();

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans">
      <nav className="border-b border-slate-800 px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-2">
           <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
             <Activity className="text-white w-5 h-5" />
           </div>
           <span className="font-bold text-xl tracking-tight text-white">Bubbles</span>
        </div>
        {isSignedIn ? (
          <Link href="/dashboard" className="text-sm font-medium hover:text-white transition-colors">
             Dashboard
          </Link>
        ) : (
          <SignInButton mode="modal">
            <button 
              className="text-sm font-medium hover:text-white transition-colors"
            >
              Login
            </button>
          </SignInButton>
        )}
      </nav>

      <main className="max-w-6xl mx-auto px-6 pt-20 pb-16">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h1 className="text-5xl font-extrabold text-white mb-6 tracking-tight leading-tight">
            High-Frequency Trading <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-500">
              Made Accessible
            </span>
          </h1>
          <p className="text-lg text-slate-400 mb-8">
            Connect your strategies directly to our low-latency execution engine. 
            Visualize order books, manage bots, and backtest in real-time.
          </p>
          {isSignedIn ? (
             <Link href="/dashboard" className="group bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-full font-semibold transition-all flex items-center gap-2 mx-auto shadow-lg shadow-blue-900/20 w-fit">
               Go to Dashboard
               <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
             </Link>
          ) : (
            <SignInButton mode="modal">
              <button 
                className="group bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-full font-semibold transition-all flex items-center gap-2 mx-auto shadow-lg shadow-blue-900/20"
              >
                Get Started
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>
            </SignInButton>
          )}
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          <div className="bg-slate-800/50 border border-slate-700 p-6 rounded-xl">
            <div className="w-12 h-12 bg-blue-500/10 rounded-lg flex items-center justify-center mb-4">
              <Zap className="w-6 h-6 text-blue-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Microsecond Latency</h3>
            <p className="text-slate-400">Direct market access via our optimized execution engine for lightning-fast order placement.</p>
          </div>
          <div className="bg-slate-800/50 border border-slate-700 p-6 rounded-xl">
            <div className="w-12 h-12 bg-green-500/10 rounded-lg flex items-center justify-center mb-4">
              <TrendingUp className="w-6 h-6 text-green-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Real-time Analytics</h3>
            <p className="text-slate-400">Monitor PnL, exposure, and strategy performance with live aggregated data streams.</p>
          </div>
          <div className="bg-slate-800/50 border border-slate-700 p-6 rounded-xl">
            <div className="w-12 h-12 bg-purple-500/10 rounded-lg flex items-center justify-center mb-4">
              <Shield className="w-6 h-6 text-purple-400" />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Secure Sandbox</h3>
            <p className="text-slate-400">Test your strategies in our isolated backtesting environment before going live.</p>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-800 py-8 text-center text-slate-500">
        &copy; Bubbles
      </footer>
    </div>
  );
}
