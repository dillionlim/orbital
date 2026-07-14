import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

// The guard lazily builds a module-level Supabase client, so the SDK is mocked
// at the module boundary and every test drives auth.getUser directly.
const mockGetUser = jest.fn();
const mockCreateClient = jest.fn(() => ({ auth: { getUser: mockGetUser } }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...(args as [])),
}));

import {
  AuthenticatedRequest,
  MAX_CACHE_ENTRIES,
  SupabaseAuthGuard,
  tokenCacheSize,
} from './supabase-auth.guard';

// Minimal ExecutionContext double exposing the request the guard mutates.
function contextOf(headers: Record<string, string | undefined>): {
  ctx: ExecutionContext;
  req: AuthenticatedRequest;
} {
  const req = { headers } as unknown as AuthenticatedRequest;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

// The token -> auth cache is module-level state shared by every guard instance,
// so each test uses a unique token to avoid bleeding into its neighbours.
let tokenSeq = 0;
function freshToken(): string {
  return `tok_${++tokenSeq}`;
}

function supabaseUser(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      user: {
        id: 'auth_user_1',
        email: 'ada@example.com',
        user_metadata: {},
        ...overrides,
      },
    },
    error: null,
  };
}

describe('SupabaseAuthGuard', () => {
  let guard: SupabaseAuthGuard;

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    mockGetUser.mockReset();
    mockCreateClient.mockClear();
    guard = new SupabaseAuthGuard();
  });

  describe('bearer token extraction', () => {
    // No credentials at all must never reach Supabase — this is the outermost
    // gate on every authenticated route.
    it('rejects a request with no Authorization header', async () => {
      const { ctx } = contextOf({});

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    // Only the `Bearer <token>` scheme is honoured; anything else is not a
    // credential this guard knows how to verify.
    it('rejects a non-Bearer Authorization scheme', async () => {
      const { ctx } = contextOf({ authorization: 'Basic YWRhOnNlY3JldA==' });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'missing bearer token',
      );
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    // "Bearer" with an empty/whitespace token is malformed, not anonymous —
    // it must not be forwarded to Supabase as an empty string.
    it('rejects a Bearer header with an empty token', async () => {
      const { ctx } = contextOf({ authorization: 'Bearer    ' });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    // The scheme check is case-sensitive and prefix-based, so a token pasted
    // without the scheme is refused rather than silently accepted.
    it('rejects a raw token sent without the Bearer prefix', async () => {
      const { ctx } = contextOf({ authorization: freshToken() });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockGetUser).not.toHaveBeenCalled();
    });
  });

  describe('token verification', () => {
    // A token Supabase refuses (expired, revoked, forged) must not authenticate.
    it('rejects a token Supabase reports as invalid or expired', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'invalid JWT' },
      });
      const { ctx } = contextOf({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'invalid or expired session',
      );
      expect(mockGetUser).toHaveBeenCalledWith(token);
    });

    // Supabase can answer 200 with no user; treating that as success would let
    // an unauthenticated request through with an undefined userId.
    it('rejects a successful response that carries no user', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
      const { ctx } = contextOf({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // The happy path: the verified Supabase user id is what every downstream
    // controller uses to scope its queries, so it must land on the request.
    it('accepts a valid token and attaches the user id to the request', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue(supabaseUser());
      const { ctx, req } = contextOf({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);

      expect(req.auth.userId).toBe('auth_user_1');
      expect(req.auth.claims.email).toBe('ada@example.com');
    });

    // Supabase stores profile fields under either naming convention depending on
    // the OAuth provider, so the guard normalizes both into one claims shape.
    it('normalizes provider metadata into the claims the controllers expect', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue(
        supabaseUser({
          user_metadata: {
            user_name: 'ada',
            preferred_username: 'ada_l',
            first_name: 'Ada',
            last_name: 'Lovelace',
          },
        }),
      );
      const { ctx, req } = contextOf({ authorization: `Bearer ${token}` });

      await guard.canActivate(ctx);

      expect(req.auth.claims).toEqual({
        email: 'ada@example.com',
        username: 'ada',
        preferred_username: 'ada_l',
        given_name: 'Ada',
        family_name: 'Lovelace',
      });
    });

    // A user with no metadata at all must still authenticate — the claims are
    // simply undefined rather than the guard blowing up on a missing object.
    it('tolerates a user with no metadata', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'auth_user_2', email: undefined } },
        error: null,
      });
      const { ctx, req } = contextOf({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.auth.userId).toBe('auth_user_2');
      expect(req.auth.claims.username).toBeUndefined();
    });
  });

  describe('token cache', () => {
    // A burst of dashboard requests shares one token; re-verifying each one
    // would put Supabase's /auth/v1/user on the critical path of every call.
    it('serves a repeat request from cache without re-verifying the token', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue(supabaseUser());

      const first = contextOf({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(first.ctx)).resolves.toBe(true);

      const second = contextOf({ authorization: `Bearer ${token}` });
      await expect(guard.canActivate(second.ctx)).resolves.toBe(true);

      expect(mockGetUser).toHaveBeenCalledTimes(1);
      expect(second.req.auth.userId).toBe('auth_user_1');
    });

    // The cache is keyed by token, not by user, so a different credential is
    // always verified on its own — a cache hit can never authenticate a stranger.
    it('verifies each distinct token separately', async () => {
      const tokenA = freshToken();
      const tokenB = freshToken();
      mockGetUser
        .mockResolvedValueOnce(supabaseUser({ id: 'auth_user_a' }))
        .mockResolvedValueOnce(supabaseUser({ id: 'auth_user_b' }));

      const a = contextOf({ authorization: `Bearer ${tokenA}` });
      const b = contextOf({ authorization: `Bearer ${tokenB}` });
      await guard.canActivate(a.ctx);
      await guard.canActivate(b.ctx);

      expect(mockGetUser).toHaveBeenCalledTimes(2);
      expect(a.req.auth.userId).toBe('auth_user_a');
      expect(b.req.auth.userId).toBe('auth_user_b');
    });

    // The cache is module-level, shared by every guard instance Nest creates —
    // this pins that a hit is not accidentally per-instance.
    it('shares cached verifications across guard instances', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue(supabaseUser());

      await guard.canActivate(
        contextOf({ authorization: `Bearer ${token}` }).ctx,
      );
      const other = new SupabaseAuthGuard();
      const second = contextOf({ authorization: `Bearer ${token}` });
      await expect(other.canActivate(second.ctx)).resolves.toBe(true);

      expect(mockGetUser).toHaveBeenCalledTimes(1);
    });

    // Rejections are never cached: a bad token must be re-checked every time, so
    // a token that only just became valid isn't locked out for the cache window.
    it('does not cache failed verifications', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'invalid JWT' },
      });

      await expect(
        guard.canActivate(contextOf({ authorization: `Bearer ${token}` }).ctx),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        guard.canActivate(contextOf({ authorization: `Bearer ${token}` }).ctx),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockGetUser).toHaveBeenCalledTimes(2);
    });

    // Entries expire after CACHE_MS, at which point the token is re-verified —
    // this bounds how long a revoked session can keep working.
    it('re-verifies a token once its cache entry expires', async () => {
      const token = freshToken();
      mockGetUser.mockResolvedValue(supabaseUser());
      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);

      try {
        await guard.canActivate(
          contextOf({ authorization: `Bearer ${token}` }).ctx,
        );
        expect(mockGetUser).toHaveBeenCalledTimes(1);

        // Jump past the 30s cache window.
        nowSpy.mockReturnValue(realNow + 31_000);
        await guard.canActivate(
          contextOf({ authorization: `Bearer ${token}` }).ctx,
        );
        expect(mockGetUser).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  // These run last: they assert on the size of the module-level cache, which the
  // tests above have already populated with (by then expired) entries.
  describe('cache eviction', () => {
    // Expired entries used to live forever. Supabase rotates tokens ~hourly, so a
    // long-lived host leaked one entry per user per hour.
    it('evicts expired entries instead of growing forever', async () => {
      mockGetUser.mockResolvedValue(supabaseUser());
      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);

      try {
        await guard.canActivate(
          contextOf({ authorization: `Bearer ${freshToken()}` }).ctx,
        );

        // Well past the 30s window: every entry cached so far is now dead, and the
        // next verification must sweep them rather than pile a new one on top.
        nowSpy.mockReturnValue(realNow + 300_000);
        await guard.canActivate(
          contextOf({ authorization: `Bearer ${freshToken()}` }).ctx,
        );

        expect(tokenCacheSize()).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    // A burst of distinct live tokens must not be able to grow the map without
    // bound either — the oldest entries are dropped once the cap is reached.
    it('caps the cache when every entry is still live', async () => {
      mockGetUser.mockResolvedValue(supabaseUser());

      for (let i = 0; i < MAX_CACHE_ENTRIES + 50; i++) {
        await guard.canActivate(
          contextOf({ authorization: `Bearer ${freshToken()}` }).ctx,
        );
      }

      expect(tokenCacheSize()).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    });
  });
});
