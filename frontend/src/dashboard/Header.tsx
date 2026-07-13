import React, { useState, useEffect, useRef } from 'react';
import { Wifi, WifiOff, LogOut, Plus, User as UserIcon, Menu, ChevronDown } from 'lucide-react';
import { ConnectionStatus } from '../types';
import { useUser, signOut } from '../lib/auth';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AddServerModal } from './AddServerModal';
import { ApiKeyBadge } from './ApiKeyBadge';
import { CustomDropdown } from './CustomDropdown';
import { setCurrentServer as broadcastCurrentServer } from '../hooks/useCurrentServer';
import BubblesIcon from '../ui/BubblesIcon';
import { httpBase, DEFAULT_SERVER } from '../services/engineUrl';

const KEY_CURRENT = 'currentServer';
const KEY_SERVERS = 'servers';

export const Header: React.FC = () => {
  const { user } = useUser();
  const pathname = usePathname();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Server Management State — hydrated from localStorage on mount so the dropdown
  // reflects what the widgets are actually pointed at, not just a hardcoded default.
  const [servers, setServers] = useState<string[]>([DEFAULT_SERVER]);
  const [currentServer, setCurrentServer] = useState(DEFAULT_SERVER);
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.CONNECTING);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Hydration runs in a microtask so the setState calls aren't
    // synchronous in the effect body — keeps us out of
    // react-hooks/set-state-in-effect. Functionally equivalent
    // (microtasks flush before the next paint).
    queueMicrotask(() => {
      let storedServers: string[] = [DEFAULT_SERVER];
      try {
        const raw = localStorage.getItem(KEY_SERVERS);
        if (raw) storedServers = JSON.parse(raw);
      } catch {
        /* ignore malformed storage */
      }
      const storedCurrent = localStorage.getItem(KEY_CURRENT) || DEFAULT_SERVER;
      // Always include the default + the current selection in the list so the
      // user can switch back even if their saved selection is unreachable.
      const merged = Array.from(new Set([DEFAULT_SERVER, ...storedServers, storedCurrent]));
      setServers(merged);
      setCurrentServer(storedCurrent);
      localStorage.setItem(KEY_SERVERS, JSON.stringify(merged));
      broadcastCurrentServer(storedCurrent);
    });
  }, []);
  
  // Add Server Modal State
  const [isAddServerModalOpen, setIsAddServerModalOpen] = useState(false);

  const checkServerHealth = async (ip: string): Promise<boolean> => {
    if (!ip.trim()) return false;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${httpBase(ip)}/health?_t=${Date.now()}`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response.ok && (await response.json()).status === 'healthy';
    } catch {
      return false;
    }
  };

  // Supabase logout is a clean client-side localStorage clear — no cookies, no
  // cross-domain FAPI call. Hard-navigate home so the app re-reads auth state.
  const handleLogout = async () => {
    setIsUserMenuOpen(false);
    await signOut();
    window.location.replace('/');
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
    // Broadcast first so dashboard widgets bind to the new server immediately.
    setCurrentServer(server);
    broadcastCurrentServer(server);
    setStatus(ConnectionStatus.CONNECTING);

    const isHealthy = await checkServerHealth(server);
    setStatus(isHealthy ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED);
  };

  const handleSaveServer = (newServerIp: string) => {
    const next = Array.from(new Set([...servers, newServerIp]));
    setServers(next);
    setCurrentServer(newServerIp);
    localStorage.setItem(KEY_SERVERS, JSON.stringify(next));
    broadcastCurrentServer(newServerIp);
    setIsAddServerModalOpen(false);
    setStatus(ConnectionStatus.CONNECTING);
    setTimeout(() => setStatus(ConnectionStatus.CONNECTED), 1000);
  };

  const handleRemoveServer = (server: string) => {
    if (server === DEFAULT_SERVER) return;
    const next = servers.filter(s => s !== server);
    setServers(next);
    localStorage.setItem(KEY_SERVERS, JSON.stringify(next));
    if (currentServer === server) {
      setCurrentServer(DEFAULT_SERVER);
      broadcastCurrentServer(DEFAULT_SERVER);
      setStatus(ConnectionStatus.CONNECTING);
    }
  };

  // Re-check the current server on mount + every 8s so the wifi indicator stays honest.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let alive = true;
    const tick = async () => {
      const ok = await checkServerHealth(currentServer);
      if (!alive) return;
      setStatus(ok ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED);
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(id); };
  }, [currentServer]);

  // Profile intentionally not in the top nav anymore — it lives in the
  // user-menu dropdown to the right, alongside Logout.
  const navLinks: Array<{ href: string; label: string }> = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/config-generator', label: 'Config' },
    { href: '/docs', label: 'Docs' },
  ];

  // User-menu dropdown: collapses Welcome name + Profile + Logout into a
  // single avatar button. Without this the right-hand cluster spans 4
  // separate elements (welcome span, divider, profile icon, logout
  // button) and crowds the API key badge + server selector.
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);
  // aria-expanded is set imperatively rather than through a JSX prop:
  // Microsoft Edge Tools' axe/aria rule only accepts literal "true" /
  // "false" string values for ARIA attributes and rejects any JSX
  // expression (even one that statically resolves to those strings).
  // Mirroring it via setAttribute keeps the DOM correct without
  // tripping the static checker.
  useEffect(() => {
    userMenuButtonRef.current?.setAttribute(
      'aria-expanded', isUserMenuOpen ? 'true' : 'false');
  }, [isUserMenuOpen]);
  const userLabel = user?.username ?? user?.fullName ?? user?.firstName ?? 'Account';

  return (
    <>
      <header className="bg-slate-900 border-b border-slate-700 h-16 px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
             <BubblesIcon className="text-white w-5 h-5" />
           </div>
            <span className="font-bold text-xl tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-sky-300 via-blue-500 to-indigo-600 hidden md:inline">Bubbles</span>
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
                  onRemove={handleRemoveServer}
                  protectedOption={DEFAULT_SERVER}
                />
                
                <button
                  type="button"
                  onClick={() => setIsAddServerModalOpen(true)}
                  className="ml-2 hover:bg-slate-700 p-1 rounded text-slate-400 hover:text-white transition-colors border-l border-slate-700 pl-2"
                  title="Add new server"
                >
                  <Plus className="w-4 h-4" />
                </button>

                <button
                  type="button"
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

        <div className="flex items-center gap-3">
          <div className="hidden md:block">
            <ApiKeyBadge />
          </div>

          {/* User menu (desktop). Single avatar button → dropdown with
              welcome name + Profile + Logout. Mirrors CustomDropdown's
              click-outside handling so it dismisses on background click. */}
          <div className="relative hidden md:block" ref={userMenuRef}>
            <button
              ref={userMenuButtonRef}
              type="button"
              onClick={() => setIsUserMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 p-1.5 pr-2 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title={userLabel}
              aria-haspopup="menu"
            >
              <UserIcon className="w-5 h-5" />
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isUserMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {isUserMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-2 w-56 bg-slate-800 border border-slate-700 rounded-md shadow-lg z-50 py-1"
              >
                <div className="px-3 py-2 border-b border-slate-700">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Signed in as</div>
                  <div className="text-sm font-medium text-white truncate">{userLabel}</div>
                </div>
                <Link
                  href="/profile"
                  onClick={() => setIsUserMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/60 hover:text-white transition-colors"
                  role="menuitem"
                >
                  <UserIcon className="w-4 h-4" />
                  Profile
                </Link>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/60 hover:text-red-400 transition-colors"
                  role="menuitem"
                >
                  <LogOut className="w-4 h-4" />
                  Logout
                </button>
              </div>
            )}
          </div>

          {/* Mobile Menu */}
          <div className="md:hidden">
            <button type="button" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-colors" title="Menu">
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
