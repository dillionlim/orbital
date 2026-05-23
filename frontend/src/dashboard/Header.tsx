import React, { useState } from 'react';
import { Wifi, WifiOff, Server, LogOut, Key, Plus, X, Save, User as UserIcon, Menu } from 'lucide-react';
import { ConnectionStatus } from '../types';
import { useClerk, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AddServerModal } from './AddServerModal';
import { CustomDropdown } from './CustomDropdown';

export const Header: React.FC = () => {
  const { user } = useUser();
  const { signOut } = useClerk();
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  
  // Server Management State
  const [servers, setServers] = useState<string[]>(['localhost:9090']);
  const [currentServer, setCurrentServer] = useState(servers[0]);
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.CONNECTED);
  
  // Add Server Modal State
  const [isAddServerModalOpen, setIsAddServerModalOpen] = useState(false);

  const checkServerHealth = async (ip: string): Promise<boolean> => {
    if (!ip.trim()) return false;
    
    const [host, port] = ip.split(':');
    const checkPort = port;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const response = await fetch(`http://${host}:${checkPort}/health?_t=${Date.now()}`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response.ok && (await response.json()).status === 'healthy';
    } catch {
      return false;
    }
  };
  
  const toggleConnection = () => {
    if (status === ConnectionStatus.CONNECTED) {
      setStatus(ConnectionStatus.DISCONNECTED);
    } else {
      setStatus(ConnectionStatus.CONNECTING);
      setTimeout(() => {
        setStatus(ConnectionStatus.CONNECTED);
      }, 1000);
    }
  };

  const handleServerChange = async (server: string) => {
    setStatus(ConnectionStatus.CONNECTING);
    
    const isHealthy = await checkServerHealth(server);
    
    if (isHealthy) {
      setCurrentServer(server);
      localStorage.setItem('currentServer', server);
      setStatus(ConnectionStatus.CONNECTED);
    } else {
      setStatus(ConnectionStatus.DISCONNECTED);
      alert(`Server ${server} is not responding. Connection aborted.`);
      // Revert status to connected for the current server after a short delay or immediately?
      // Since we didn't switch currentServer, we are technically still connected to the old one (if it was up).
      // But showing DISCONNECTED briefly is good feedback.
      setTimeout(() => setStatus(ConnectionStatus.CONNECTED), 2000);
    }
  };

  const handleSaveServer = (newServerIp: string) => {
    setServers([...servers, newServerIp]);
    setCurrentServer(newServerIp);
    localStorage.setItem('currentServer', newServerIp);
    setIsAddServerModalOpen(false);
    setStatus(ConnectionStatus.CONNECTING);
    setTimeout(() => setStatus(ConnectionStatus.CONNECTED), 1000);
  };

  const navLinks = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/profile', label: 'Profile' },
  ];

  return (
    <>
      <header className="bg-slate-900 border-b border-slate-700 h-16 px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Server className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-white hidden md:inline">Bubbles</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-4">
            {navLinks.map((link) => (
              <Link key={link.href} href={link.href}>
                <span className={`text-sm font-medium transition-colors ${pathname === link.href ? 'text-white' : 'text-slate-400 hover:text-white'}`}>
                  {link.label}
                </span>
              </Link>
            ))}
          </nav>
        </div>

        {/* Server Selector */}
        <div className="flex-1 flex justify-center px-4">
          <div className="flex items-center gap-2">
             <span className="text-slate-400 text-xs font-mono hidden sm:inline">SERVER:</span>
             
             <div className="flex items-center bg-slate-800 rounded-md border border-slate-700 px-3 py-1.5 w-64 md:w-80">
                <CustomDropdown 
                  options={servers}
                  selected={currentServer}
                  onChange={handleServerChange}
                />
                
                <button 
                  onClick={() => setIsAddServerModalOpen(true)}
                  className="ml-2 hover:bg-slate-700 p-1 rounded text-slate-400 hover:text-white transition-colors border-l border-slate-700 pl-2"
                  title="Add new server"
                >
                  <Plus className="w-4 h-4" />
                </button>

                <button 
                  onClick={toggleConnection} 
                  className="ml-2 hover:bg-slate-700 p-1 rounded transition-colors"
                  title={status === ConnectionStatus.CONNECTED ? "Disconnect" : "Connect"}
                >
                  {status === ConnectionStatus.CONNECTED ? (
                    <Wifi className="w-4 h-4 text-green-500" />
                  ) : status === ConnectionStatus.CONNECTING ? (
                    <div className="w-4 h-4 border-2 border-slate-500 border-t-white rounded-full animate-spin" />
                  ) : (
                    <WifiOff className="w-4 h-4 text-red-500" />
                  )}
                </button>
             </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden lg:flex flex-col items-end">
            <span className="text-sm font-medium text-white">Welcome, {user?.username || user?.fullName || user?.firstName}</span>
          </div>
          
          <div className="h-8 w-[1px] bg-slate-700 mx-2 hidden lg:block"></div>

          <Link href="/profile" className="p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-colors" title="Profile">
            <UserIcon className="w-5 h-5" />
          </Link>

          <button 
            onClick={() => signOut()}
            className="flex items-center gap-2 text-slate-400 hover:text-red-400 transition-colors text-sm font-medium"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden md:inline">Logout</span>
          </button>

          {/* Mobile Menu */}
          <div className="md:hidden">
            <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-colors" title="Menu">
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>

        {isMobileMenuOpen && (
          <div className="absolute top-16 left-0 right-0 bg-slate-900 border-b border-slate-700 md:hidden">
            <nav className="flex flex-col p-4">
              {navLinks.map((link) => (
                <Link key={link.href} href={link.href}>
                  <span className={`block py-2 text-sm font-medium transition-colors ${pathname === link.href ? 'text-white' : 'text-slate-400 hover:text-white'}`} onClick={() => setIsMobileMenuOpen(false)}>
                    {link.label}
                  </span>
                </Link>
              ))}
            </nav>
          </div>
        )}
      </header>

      {isAddServerModalOpen && (
        <AddServerModal 
          onClose={() => setIsAddServerModalOpen(false)}
          onSave={handleSaveServer}
          servers={servers}
        />
      )}
    </>
  );
};
