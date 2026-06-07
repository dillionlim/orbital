'use client';

import React, { useState } from 'react';
import { Key, Eye, EyeOff, Copy, Check, Loader2 } from 'lucide-react';
import { useApiKey } from '../hooks/useApiKey';

function masked(key: string): string {
  // sk_live_<32 hex>  →  sk_live_••••<last 4>
  const tail = key.slice(-4);
  return `sk_live_••••${tail}`;
}

export const ApiKeyBadge: React.FC = () => {
  const { apiKey, isLoading, hasApiKey, generateApiKey } = useApiKey();
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleCopy = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* permission denied — silent */ }
  };

  const handleGenerate = async () => {
    if (busy) return;
    if (apiKey) {
      const ok = window.confirm(
        'Regenerate API key? Bots using the old key will be rejected.\n' +
        '(Use the Profile page if you want a confirmation step every time.)'
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await generateApiKey();
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs text-slate-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>API key…</span>
      </div>
    );
  }

  if (!hasApiKey) {
    return (
      <button
        type="button"
        onClick={handleGenerate}
        disabled={busy}
        className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 rounded-md text-xs font-medium text-white transition-colors"
        title="Create your first API key"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
        <span>Generate API Key</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-xs">
      <Key className="w-3.5 h-3.5 text-slate-400" />
      <span className="font-mono text-slate-200 select-all">
        {reveal ? apiKey : masked(apiKey!)}
      </span>
      <button
        type="button"
        onClick={() => setReveal(v => !v)}
        className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700"
        title={reveal ? 'Hide key' : 'Reveal key'}
      >
        {reveal ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      </button>
      <button
        type="button"
        onClick={handleCopy}
        className={`p-1 rounded hover:bg-slate-700 ${copied ? 'text-green-400' : 'text-slate-400 hover:text-white'}`}
        title={copied ? 'Copied!' : 'Copy to clipboard'}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
};
