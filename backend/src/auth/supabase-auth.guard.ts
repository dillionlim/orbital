import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Request } from 'express';

// Auth info attached to the request, kept in the same shape the controllers
// already expect from the old Clerk guard (userId + claims) so they don't change.
export interface SupabaseAuthInfo {
  userId: string;
  sessionId: string;
  claims: {
    email?: string;
    username?: string;
    preferred_username?: string;
    given_name?: string;
    family_name?: string;
  };
}

export type AuthenticatedRequest = Request & { auth: SupabaseAuthInfo };

let client: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Short-lived cache of token -> auth info so a burst of requests from the same
// client doesn't hit Supabase's /auth/v1/user on every call.
const cache = new Map<string, { auth: SupabaseAuthInfo; exp: number }>();
const CACHE_MS = 30_000;
export const MAX_CACHE_ENTRIES = 1_000;

// Supabase rotates tokens ~hourly, so entries are dead weight the moment they
// expire — without this the map grows forever on a long-lived host.
function pruneCache(now: number): void {
  for (const [token, entry] of cache) {
    if (entry.exp <= now) cache.delete(token);
  }
  // Still full of live entries (a burst of distinct tokens): drop the oldest,
  // which Map iterates first.
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Test seam: the cache is module-level, so its size is otherwise unobservable.
export function tokenCacheSize(): number {
  return cache.size;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : '';
    if (!token) throw new UnauthorizedException('missing bearer token');

    const now = Date.now();
    const hit = cache.get(token);
    if (hit && hit.exp > now) {
      req.auth = hit.auth;
      return true;
    }
    pruneCache(now);

    const { data, error } = await supabase().auth.getUser(token);
    if (error || !data?.user) {
      throw new UnauthorizedException('invalid or expired session');
    }
    const u = data.user;
    const meta = (u.user_metadata ?? {}) as Record<string, string>;
    const auth: SupabaseAuthInfo = {
      userId: u.id,
      sessionId: '',
      claims: {
        email: u.email,
        username: meta.username || meta.user_name,
        preferred_username: meta.preferred_username,
        given_name: meta.given_name || meta.first_name,
        family_name: meta.family_name || meta.last_name,
      },
    };
    cache.set(token, { auth, exp: now + CACHE_MS });
    req.auth = auth;
    return true;
  }
}
