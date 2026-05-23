"use client";

import { useUser } from "@clerk/nextjs";
import { Header } from "@/src/dashboard/Header";

export default function Dashboard() {
  const { isLoaded } = useUser();

  if (!isLoaded) {
    return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans selection:bg-blue-500/30">
      <Header />
      
      <main>
      </main>
    </div>
  );
}
