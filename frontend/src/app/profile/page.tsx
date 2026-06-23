"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { Header } from '@/src/dashboard/Header';
import { Key, RefreshCw, CheckCircle, Eye, EyeOff, Pencil, Check, X } from 'lucide-react';
import { apiKeysService } from '@/src/services/apiKeys';

interface ApiKey {
  id: string;
  key: string;
  name: string;
  userId: string;
  createdAt: Date;
}

export default function ProfilePage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [visibleKey, setVisibleKey] = useState<string | null>(null);

  // --- Username editing ---
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  const toggleVisibility = (key: string) => {
    setVisibleKey((cur) => (cur === key ? null : key));
  };

  const fetchApiKeys = async () => {
    try {
      const keys = await apiKeysService.getApiKeys();
      setApiKeys(keys);
    } catch (error) {
      console.error("Failed to fetch API keys", error);
    }
  };

  useEffect(() => {
    if (isLoaded && user) {
      fetchApiKeys();
    }
  }, [isLoaded, user]);

  // Backstop: bounce signed-out visitors off the profile.
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace('/');
  }, [isLoaded, isSignedIn, router]);

  const generateNewKey = async () => {
    setIsGenerating(true);
    try {
      await apiKeysService.createApiKey();
      await fetchApiKeys();
    } catch (error) {
      console.error("Failed to generate API key", error);
    } finally {
      setIsGenerating(false);
    }
  };

  // --- Username handlers ---
  const startEditUsername = () => {
    setUsernameDraft(user?.username ?? '');
    setUsernameError(null);
    setEditingUsername(true);
  };

  const saveUsername = async () => {
    if (!user) return;
    const next = usernameDraft.trim();
    if (!next || next === user.username) {
      setEditingUsername(false);
      return;
    }
    setSavingUsername(true);
    setUsernameError(null);
    try {
      // Updates user_metadata; Supabase fires a USER_UPDATED event that our
      // AuthProvider listens for, so the displayed username re-renders.
      const { error } = await supabase.auth.updateUser({ data: { username: next } });
      if (error) throw error;
      setEditingUsername(false);
    } catch (err) {
      console.error('username update failed', err);
      setUsernameError(err instanceof Error ? err.message : 'Could not update username.');
    } finally {
      setSavingUsername(false);
    }
  };

  if (!isLoaded || !isSignedIn) return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Loading...</div>;

  const fieldBox = "bg-slate-900 border border-slate-700 rounded-lg p-3";
  const inputCls = "flex-1 bg-slate-900 border border-slate-700 rounded-lg p-3 text-white text-sm focus:outline-none focus:border-blue-500";
  const iconBtn = "p-2 rounded-lg transition-colors disabled:opacity-50";

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200">
      <Header />

      <main className="max-w-4xl mx-auto p-6 pt-12">
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden shadow-2xl">
          <div className="p-8 border-b border-slate-700 bg-slate-800/50">
            <h1 className="text-3xl font-bold text-white mb-2">User Profile</h1>
            <p className="text-slate-400 text-sm">Manage your account settings and API access.</p>
          </div>

          <div className="p-8 space-y-8">
            {/* User Info */}
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4">Account Details</h2>
              <div className="grid grid-cols-1 gap-6">
                {/* Username */}
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Username</label>
                  {editingUsername ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        className={inputCls}
                        value={usernameDraft}
                        placeholder="username"
                        disabled={savingUsername}
                        onChange={(e) => setUsernameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveUsername();
                          if (e.key === 'Escape') setEditingUsername(false);
                        }}
                      />
                      <button
                        onClick={saveUsername}
                        disabled={savingUsername}
                        className={`${iconBtn} bg-blue-600 hover:bg-blue-500 text-white`}
                        title="Save"
                      >
                        {savingUsername ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => setEditingUsername(false)}
                        disabled={savingUsername}
                        className={`${iconBtn} bg-slate-700 hover:bg-slate-600 text-white`}
                        title="Cancel"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className={`${fieldBox} flex items-center justify-between group`}>
                      <span className={user?.username ? 'text-white' : 'text-slate-400'}>
                        {user?.username || 'Not set'}
                      </span>
                      <button
                        onClick={startEditUsername}
                        className="text-slate-500 hover:text-white"
                        title="Edit username"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  {usernameError && <p className="text-xs text-red-400 mt-1">{usernameError}</p>}
                </div>
              </div>
            </section>

            {/* API Keys */}
            <section>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">API Access Keys</h2>
                <button
                  onClick={generateNewKey}
                  disabled={isGenerating}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white text-xs font-bold py-2 px-4 rounded-lg transition-colors"
                >
                  {isGenerating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
                  Regenerate API Key
                </button>
              </div>

              <div className="space-y-3">
                {apiKeys.length > 0 ? (
                  apiKeys.map((key) => (
                    <div key={key.id} className="bg-slate-900 border border-slate-700 rounded-lg p-4 flex items-center justify-between group">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-blue-400">
                            {visibleKey === key.id ? key.key : '********************'}
                          </span>
                          <button onClick={() => toggleVisibility(key.id)} className="text-slate-500 hover:text-white">
                            {visibleKey === key.id ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                          <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                        </div>
                        <span className="text-[10px] text-slate-500">Created: {new Date(key.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="text-[10px] bg-slate-800 text-slate-400 px-2 py-1 rounded border border-slate-700">
                        ACTIVE
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8 bg-slate-900/50 border border-dashed border-slate-700 rounded-lg text-slate-500 text-sm">
                    No API keys found. Click &quot;Regenerate&quot; to create one.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
