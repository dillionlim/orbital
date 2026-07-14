import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// `req.auth` is whatever the SupabaseAuthGuard verified and attached; the
// controller only ever reads from it.
function requestOf(
  userId: string,
  claims: Record<string, string | undefined> = {},
) {
  return {
    auth: { userId, sessionId: 'sess_1', claims },
  } as unknown as Parameters<UsersController['syncUser']>[0];
}

describe('UsersController', () => {
  let controller: UsersController;
  let service: {
    getUsernames: jest.Mock;
    syncUser: jest.Mock;
  };

  beforeEach(() => {
    service = {
      getUsernames: jest.fn(),
      syncUser: jest.fn(),
    };

    controller = new UsersController(service as unknown as UsersService);
  });

  // The id list the service actually sees, after the route's slice(0, 500).
  function idsPassed(): string[] {
    const calls = service.getUsernames.mock.calls as unknown as [string[]][];
    return calls[0][0];
  }

  describe('POST /users/names', () => {
    // The leaderboard join: engine ids in, display names out.
    it('resolves the requested user ids to usernames', async () => {
      service.getUsernames.mockResolvedValue({ auth_user_1: 'ada' });

      await expect(controller.names({ ids: ['auth_user_1'] })).resolves.toEqual(
        { auth_user_1: 'ada' },
      );

      expect(service.getUsernames).toHaveBeenCalledWith(['auth_user_1']);
    });

    // Without an upper bound a caller could ask Prisma to build an unbounded
    // `IN (...)` list, so the route clamps the batch to 500 ids.
    it('clamps an oversized id batch to the first 500 entries', async () => {
      service.getUsernames.mockResolvedValue({});
      const ids = Array.from({ length: 900 }, (_, i) => `auth_user_${i}`);

      await controller.names({ ids });

      const passed = idsPassed();
      expect(passed).toHaveLength(500);
      expect(passed[0]).toBe('auth_user_0');
      expect(passed.at(-1)).toBe('auth_user_499');
    });

    // A batch at exactly the limit must survive the clamp untouched.
    it('passes a batch of exactly 500 ids through unchanged', async () => {
      service.getUsernames.mockResolvedValue({});
      const ids = Array.from({ length: 500 }, (_, i) => `auth_user_${i}`);

      await controller.names({ ids });

      expect(idsPassed()).toHaveLength(500);
    });

    // A missing or non-array `ids` is a malformed body, not a reason to 500 —
    // it degrades to an empty lookup.
    it('treats a missing or non-array ids field as an empty lookup', async () => {
      service.getUsernames.mockResolvedValue({});

      await controller.names({});
      await controller.names({ ids: 'auth_user_1' } as unknown as {
        ids?: string[];
      });

      expect(service.getUsernames).toHaveBeenNthCalledWith(1, []);
      expect(service.getUsernames).toHaveBeenNthCalledWith(2, []);
    });
  });

  describe('POST /users/sync', () => {
    // Sync provisions the profile from the verified token claims only — nothing
    // in the request body can influence which user is written.
    it('syncs the authenticated user from their token claims', async () => {
      const user = { id: 'db_user_1', clerkId: 'auth_user_1', apiKey: null };
      service.syncUser.mockResolvedValue(user);

      await expect(
        controller.syncUser(
          requestOf('auth_user_1', {
            email: 'ada@example.com',
            username: 'ada',
            given_name: 'Ada',
            family_name: 'Lovelace',
          }),
        ),
      ).resolves.toBe(user);

      expect(service.syncUser).toHaveBeenCalledWith(
        'auth_user_1',
        'ada@example.com',
        'ada',
        'Ada',
        'Lovelace',
      );
    });

    // OAuth providers that only expose preferred_username still need to end up
    // with a display name.
    it('falls back to preferred_username for the display name', async () => {
      service.syncUser.mockResolvedValue({});

      await controller.syncUser(
        requestOf('auth_user_1', {
          email: 'ada@example.com',
          preferred_username: 'ada_l',
        }),
      );

      expect(service.syncUser).toHaveBeenCalledWith(
        'auth_user_1',
        'ada@example.com',
        'ada_l',
        undefined,
        undefined,
      );
    });

    // Email is required by the schema, so a claimless token gets a synthetic
    // no-reply address rather than a failed insert.
    it('synthesizes a no-reply email when the token has no claims', async () => {
      service.syncUser.mockResolvedValue({});

      await controller.syncUser(requestOf('auth_user_1'));

      expect(service.syncUser).toHaveBeenCalledWith(
        'auth_user_1',
        'auth_user_1@users.noreply',
        undefined,
        undefined,
        undefined,
      );
    });
  });
});
