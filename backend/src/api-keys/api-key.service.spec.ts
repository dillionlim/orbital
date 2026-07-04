import { ApiKeyService } from './api-key.service';
import { PrismaService } from '../prisma.service';

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    apiKey: {
      deleteMany: jest.Mock;
      create: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      apiKey: {
        deleteMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
    };

    service = new ApiKeyService(prisma as unknown as PrismaService);
  });

  describe('createApiKey', () => {
    // Covers first-time key creation and single-key rotation behavior.
    it('creates the user, removes old keys, and stores a generated key', async () => {
      const user = {
        id: 'db_user_1',
        clerkId: 'auth_user_1',
        email: 'ada@example.com',
        username: 'ada',
      };
      const apiKey = {
        id: 'key_1',
        key: 'sk_live_saved',
        name: 'Default API Key',
        userId: user.id,
      };

      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(user);
      prisma.apiKey.create.mockResolvedValue(apiKey);

      await expect(
        service.createApiKey(user.clerkId, user.email, user.username),
      ).resolves.toBe(apiKey);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          clerkId: user.clerkId,
          email: user.email,
          username: user.username,
        },
      });
      expect(prisma.apiKey.deleteMany).toHaveBeenCalledWith({
        where: { userId: user.id },
      });
      expect(prisma.apiKey.create).toHaveBeenCalledWith({
        data: {
          key: expect.stringMatching(/^sk_live_[0-9a-f]{32}$/),
          name: 'Default API Key',
          userId: user.id,
        },
      });
    });

    // Ensures profile drift is saved before issuing a replacement key.
    it('updates the stored username before rotating an existing user key', async () => {
      const oldUser = {
        id: 'db_user_1',
        clerkId: 'auth_user_1',
        email: 'ada@example.com',
        username: 'old_name',
      };
      const updatedUser = { ...oldUser, username: 'ada' };

      prisma.user.findUnique.mockResolvedValue(oldUser);
      prisma.user.update.mockResolvedValue(updatedUser);
      prisma.apiKey.create.mockResolvedValue({ id: 'key_1' });

      await service.createApiKey(oldUser.clerkId, oldUser.email, 'ada');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { clerkId: oldUser.clerkId },
        data: { username: 'ada' },
      });
      expect(prisma.apiKey.deleteMany).toHaveBeenCalledWith({
        where: { userId: updatedUser.id },
      });
    });
  });

  describe('getApiKeys', () => {
    // Keeps the API-key list response compatible with the frontend.
    it('preserves the frontend array contract around the 1:1 apiKey relation', async () => {
      const key = { id: 'key_1', key: 'sk_live_abc', userId: 'db_user_1' };
      prisma.user.findUnique.mockResolvedValue({ id: 'db_user_1', apiKey: key });

      await expect(service.getApiKeys('auth_user_1')).resolves.toEqual([key]);
    });

    // Documents the no-key response for missing users or credentials.
    it('returns an empty array when the user or key is missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getApiKeys('missing')).resolves.toEqual([]);
    });
  });

  describe('deleteApiKey', () => {
    // Verifies key deletion is scoped to the requesting owner.
    it('deletes only keys owned by the authenticated user', async () => {
      const deleted = { id: 'key_1', userId: 'db_user_1' };
      prisma.apiKey.findUnique.mockResolvedValue({
        id: 'key_1',
        user: { clerkId: 'auth_user_1' },
      });
      prisma.apiKey.delete.mockResolvedValue(deleted);

      await expect(
        service.deleteApiKey('key_1', 'auth_user_1'),
      ).resolves.toBe(deleted);

      expect(prisma.apiKey.delete).toHaveBeenCalledWith({
        where: { id: 'key_1' },
      });
    });

    // Covers unauthorized and not-found delete attempts.
    it('rejects deletion when the key is missing or owned by another user', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({
        id: 'key_1',
        user: { clerkId: 'other_user' },
      });

      await expect(
        service.deleteApiKey('key_1', 'auth_user_1'),
      ).rejects.toThrow('Unauthorized or API Key not found');
      expect(prisma.apiKey.delete).not.toHaveBeenCalled();
    });
  });

  describe('validateApiKey', () => {
    // Ensures obviously invalid keys fail before any DB lookup.
    it('rejects malformed keys without querying the database', async () => {
      await expect(service.validateApiKey('bad_key')).resolves.toEqual({
        valid: false,
      });

      expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    });

    // Checks successful validation returns the engine-facing user id.
    it('accepts an active, unexpired key and returns the owning auth user id', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({
        key: 'sk_live_valid',
        isActive: true,
        expiresAt: new Date(Date.now() + 60_000),
        user: { clerkId: 'auth_user_1' },
      });

      await expect(service.validateApiKey('sk_live_valid')).resolves.toEqual({
        valid: true,
        userId: 'auth_user_1',
      });
    });

    // Covers valid-looking keys that are no longer usable.
    it('rejects inactive or expired keys', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({
        key: 'sk_live_expired',
        isActive: true,
        expiresAt: new Date(Date.now() - 1_000),
        user: { clerkId: 'auth_user_1' },
      });

      await expect(service.validateApiKey('sk_live_expired')).resolves.toEqual({
        valid: false,
      });
    });
  });
});
