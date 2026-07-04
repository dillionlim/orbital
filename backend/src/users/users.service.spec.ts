import { ApiKeyService } from '../api-keys/api-key.service';
import { PrismaService } from '../prisma.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    apiKey: {
      upsert: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      apiKey: {
        upsert: jest.fn(),
      },
    };

    service = new UsersService(
      prisma as unknown as PrismaService,
      {} as ApiKeyService,
    );
  });

  describe('syncUser', () => {
    // Verifies user sync creates both profile and default API key.
    it('creates a missing user and atomically provisions the first API key', async () => {
      const createdUser = {
        id: 'db_user_1',
        clerkId: 'auth_user_1',
        email: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        apiKey: null,
      };
      const reloadedUser = {
        ...createdUser,
        apiKey: { id: 'key_1', key: 'sk_live_saved', userId: createdUser.id },
      };

      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(reloadedUser);
      prisma.user.create.mockResolvedValue(createdUser);

      await expect(
        service.syncUser(
          'auth_user_1',
          'ada@example.com',
          'ada',
          'Ada',
          'Lovelace',
        ),
      ).resolves.toBe(reloadedUser);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          clerkId: 'auth_user_1',
          email: 'ada@example.com',
          username: 'ada',
          firstName: 'Ada',
          lastName: 'Lovelace',
        },
        include: { apiKey: true },
      });
      expect(prisma.apiKey.upsert).toHaveBeenCalledWith({
        where: { userId: createdUser.id },
        update: {},
        create: {
          key: expect.stringMatching(/^sk_live_[0-9a-f]{32}$/),
          name: 'Default API Key',
          userId: createdUser.id,
        },
      });
    });

    // Ensures profile updates do not churn an existing credential.
    it('updates changed profile fields without rotating an existing key', async () => {
      const existingUser = {
        id: 'db_user_1',
        clerkId: 'auth_user_1',
        email: 'old@example.com',
        username: 'old',
        firstName: 'Old',
        lastName: 'Name',
        apiKey: { id: 'key_1', key: 'sk_live_existing' },
      };
      const updatedUser = {
        ...existingUser,
        email: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
      };

      prisma.user.findUnique.mockResolvedValue(existingUser);
      prisma.user.update.mockResolvedValue(updatedUser);

      await expect(
        service.syncUser(
          'auth_user_1',
          'ada@example.com',
          'ada',
          'Ada',
          'Lovelace',
        ),
      ).resolves.toBe(updatedUser);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { clerkId: 'auth_user_1' },
        data: {
          email: 'ada@example.com',
          username: 'ada',
          firstName: 'Ada',
          lastName: 'Lovelace',
        },
        include: { apiKey: true },
      });
      expect(prisma.apiKey.upsert).not.toHaveBeenCalled();
    });

    // Protects the no-op path for already-synced users.
    it('leaves an unchanged user with an existing key alone', async () => {
      const existingUser = {
        id: 'db_user_1',
        clerkId: 'auth_user_1',
        email: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        apiKey: { id: 'key_1', key: 'sk_live_existing' },
      };

      prisma.user.findUnique.mockResolvedValue(existingUser);

      await expect(
        service.syncUser(
          'auth_user_1',
          'ada@example.com',
          'ada',
          'Ada',
          'Lovelace',
        ),
      ).resolves.toBe(existingUser);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.apiKey.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getUsernames', () => {
    // Avoids unnecessary database work for empty leaderboard joins.
    it('short-circuits empty lookup requests', async () => {
      await expect(service.getUsernames([])).resolves.toEqual({});
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    // Checks leaderboard user ids resolve to display names only.
    it('maps auth user ids to usernames for leaderboard joins', async () => {
      prisma.user.findMany.mockResolvedValue([
        { clerkId: 'auth_user_1', username: 'ada' },
        { clerkId: 'auth_user_2', username: null },
      ]);

      await expect(
        service.getUsernames(['auth_user_1', 'auth_user_2']),
      ).resolves.toEqual({
        auth_user_1: 'ada',
        auth_user_2: '',
      });

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { clerkId: { in: ['auth_user_1', 'auth_user_2'] } },
        select: { clerkId: true, username: true },
      });
    });
  });
});
