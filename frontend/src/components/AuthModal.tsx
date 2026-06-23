'use client';

import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

const field =
  'w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';

// Supabase Auth needs an email identifier, but Bubbles is username-only. Map a
// username to a stable synthetic internal address — the user never sees it.
function syntheticEmail(username: string): string {
  const local = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `${local}@bubbles.local`;
}

export function AuthModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const name = username.trim();
    if (!name) {
      setError('Username is required.');
      return;
    }
    setBusy(true);
    try {
      const email = syntheticEmail(name);
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          throw new Error(
            /invalid login/i.test(error.message)
              ? 'Invalid username or password.'
              : error.message,
          );
        }
        onClose();
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: name } },
        });
        if (error) {
          throw new Error(
            /already registered/i.test(error.message)
              ? 'That username is taken.'
              : error.message,
          );
        }
        if (data.session) {
          onClose(); // confirm-email off -> signed straight in
        } else {
          setError('Account created — you can sign in now.');
          setMode('signin');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white mb-4">
          {mode === 'signin' ? 'Sign in to Bubbles' : 'Create your account'}
        </h2>
        <form onSubmit={submit} className="space-y-3">
          <input
            className={field}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            autoFocus
          />
          <input
            className={field}
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
          className="mt-4 w-full text-center text-xs text-slate-400 hover:text-white transition-colors"
        >
          {mode === 'signin'
            ? "Don't have an account? Sign up"
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
