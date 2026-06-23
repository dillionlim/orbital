import { createClient } from '@supabase/supabase-js';

// Browser Supabase client. The session lives in localStorage (not cookies), so
// auth works on a public-suffix host like *.pages.dev where cookie-based auth
// (Clerk) cannot. NEXT_PUBLIC_* vars are inlined at build time.
// Placeholders keep `createClient` from throwing during `next build` prerender
// when the env isn't present. The real NEXT_PUBLIC_* values are inlined at build
// time when set (locally via .env, on Cloudflare Pages via project env vars).
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
