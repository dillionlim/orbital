'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User as SupaUser } from '@supabase/supabase-js';
import { supabase } from './supabase';

// A normalized user shaped loosely like Clerk's so existing components only need
// to swap their import. Profile editing uses the Supabase client directly.
export interface AppUser {
  id: string;
  email: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}

function normalize(u: SupaUser | null): AppUser | null {
  if (!u) return null;
  const m = (u.user_metadata ?? {}) as Record<string, string | undefined>;
  const firstName = m.first_name ?? m.given_name ?? null;
  const lastName = m.last_name ?? m.family_name ?? null;
  const username =
    m.username ?? m.user_name ?? u.email?.split('@')[0] ?? null;
  const fullName =
    m.full_name ?? [firstName, lastName].filter(Boolean).join(' ') ?? null;
  return {
    id: u.id,
    email: u.email ?? null,
    username,
    firstName,
    lastName,
    fullName: fullName || null,
    primaryEmailAddress: u.email ? { emailAddress: u.email } : null,
  };
}

interface AuthState {
  session: Session | null;
  user: AppUser | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setLoading(false);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{ session, user: normalize(session?.user ?? null), loading }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// Clerk-shaped hooks so call sites change only their import path.
export function useUser() {
  const { user, loading } = useContext(AuthContext);
  return { user, isLoaded: !loading, isSignedIn: !!user };
}

export function useAuth() {
  const { session, user, loading } = useContext(AuthContext);
  return {
    isLoaded: !loading,
    isSignedIn: !!user,
    userId: user?.id ?? null,
    getToken: async (): Promise<string | null> => {
      // Prefer the live session (auto-refreshed); fall back to context.
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? session?.access_token ?? null;
    },
  };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
