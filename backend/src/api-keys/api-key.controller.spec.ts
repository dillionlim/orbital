import { HttpException } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';

// The routes take the express Request only to read `req.auth`, which the
// SupabaseAuthGuard has already populated by the time the handler runs.
function requestOf(
  userId: string,
  claims: Record<string, string | undefined> = {},
) {
  return {
    auth: { userId, sessionId: 'sess_1', claims },
  } as unknown as Parameters<ApiKeyController['getApiKeys']>[0];
}

describe('ApiKeyController', () => {
  let controller: ApiKeyController;
  let service: {
    createApiKey: jest.Mock;
    getApiKeys: jest.Mock;
    deleteApiKey: jest.Mock;
    validateApiKey: jest.Mock;
  };

  beforeEach(() => {
    service = {
      createApiKey: jest.fn(),
      getApiKeys: jest.fn(),
      deleteApiKey: jest.fn(),
      validateApiKey: jest.fn(),
    };

    controller = new ApiKeyController(service as unknown as ApiKeyService);
  });

  describe('POST /api-keys', () => {
    // The key must be minted for the authenticated caller, never for a user id
    // taken from the body or query.
    it('issues a key for the authenticated user using their verified claims', async () => {
      const created = { id: 'key_1', key: 'sk_live_new', userId: 'db_user_1' };
      service.createApiKey.mockResolvedValue(created);

      await expect(
        controller.createApiKey(
          requestOf('auth_user_1', {
            email: 'ada@example.com',
            username: 'ada',
          }),
        ),
      ).resolves.toBe(created);

      expect(service.createApiKey).toHaveBeenCalledWith(
        'auth_user_1',
        'ada@example.com',
        'ada',
      );
    });

    // Some providers hand back a preferred_username instead of username; the
    // route should fall back rather than provisioning a nameless user.
    it('falls back to preferred_username when username is absent', async () => {
      service.createApiKey.mockResolvedValue({ id: 'key_1' });

      await controller.createApiKey(
        requestOf('auth_user_1', {
          email: 'ada@example.com',
          preferred_username: 'ada_l',
        }),
      );

      expect(service.createApiKey).toHaveBeenCalledWith(
        'auth_user_1',
        'ada@example.com',
        'ada_l',
      );
    });

    // Email is a NOT NULL column, so a token without an email claim still needs
    // a synthetic address rather than failing the insert.
    it('synthesizes an email when the token carries no email claim', async () => {
      service.createApiKey.mockResolvedValue({ id: 'key_1' });

      await controller.createApiKey(requestOf('auth_user_1'));

      expect(service.createApiKey).toHaveBeenCalledWith(
        'auth_user_1',
        'user_auth_user_1@clerk.dev',
        undefined,
      );
    });
  });

  describe('GET /api-keys', () => {
    // Listing is scoped to the caller: the auth user id is the only key the
    // service ever sees.
    it('lists only the authenticated user’s keys', async () => {
      const keys = [{ id: 'key_1', key: 'sk_live_abc' }];
      service.getApiKeys.mockResolvedValue(keys);

      await expect(
        controller.getApiKeys(requestOf('auth_user_1')),
      ).resolves.toBe(keys);

      expect(service.getApiKeys).toHaveBeenCalledWith('auth_user_1');
    });

    // A user who has never provisioned a key gets an empty list, not an error.
    it('returns an empty list when the user has no key', async () => {
      service.getApiKeys.mockResolvedValue([]);

      await expect(
        controller.getApiKeys(requestOf('auth_user_2')),
      ).resolves.toEqual([]);
    });
  });

  describe('DELETE /api-keys/:id', () => {
    // Ownership is enforced in the service, so the route must pass the caller's
    // id along with the key id — never the key id alone.
    it('deletes the key on behalf of the authenticated user', async () => {
      const deleted = { id: 'key_1', userId: 'db_user_1' };
      service.deleteApiKey.mockResolvedValue(deleted);

      await expect(
        controller.deleteApiKey('key_1', requestOf('auth_user_1')),
      ).resolves.toBe(deleted);

      expect(service.deleteApiKey).toHaveBeenCalledWith('key_1', 'auth_user_1');
    });

    // Cross-tenant deletes are rejected by the service; the route must surface
    // that rather than swallowing it into a 200.
    it('propagates the service rejection for another user’s key', async () => {
      service.deleteApiKey.mockRejectedValue(
        new Error('Unauthorized or API Key not found'),
      );

      await expect(
        controller.deleteApiKey('key_1', requestOf('auth_user_1')),
      ).rejects.toThrow('Unauthorized or API Key not found');
    });
  });

  describe('POST /api-keys/validate', () => {
    // The engine-facing route is unauthenticated, so a body without a key must
    // be rejected before it can reach Prisma.
    it('rejects a request with no key in the body', async () => {
      await expect(controller.validateApiKey({}, '')).rejects.toThrow(
        HttpException,
      );
      expect(service.validateApiKey).not.toHaveBeenCalled();
    });

    // With no shared secret configured the endpoint stays open (dev-friendly)
    // and simply forwards the key to the validator.
    it('validates the key when no shared secret is configured', async () => {
      delete process.env.ENGINE_SHARED_SECRET;
      service.validateApiKey.mockResolvedValue({
        valid: true,
        userId: 'auth_user_1',
      });

      await expect(
        controller.validateApiKey({ key: 'sk_live_abc' }, ''),
      ).resolves.toEqual({ valid: true, userId: 'auth_user_1' });
    });

    // Once ENGINE_SHARED_SECRET is set, a caller without it is a stranger and
    // must not be able to mount a DB-DoS amplifier against findUnique.
    it('rejects a mismatched engine secret before touching the database', async () => {
      process.env.ENGINE_SHARED_SECRET = 'super-secret';
      try {
        await expect(
          controller.validateApiKey({ key: 'sk_live_abc' }, 'wrong'),
        ).rejects.toThrow('engine secret missing or invalid');
        expect(service.validateApiKey).not.toHaveBeenCalled();
      } finally {
        delete process.env.ENGINE_SHARED_SECRET;
      }
    });

    // The matching secret is the engine's ticket through the gate.
    it('accepts the request when the engine secret matches', async () => {
      process.env.ENGINE_SHARED_SECRET = 'super-secret';
      service.validateApiKey.mockResolvedValue({ valid: false });
      try {
        await expect(
          controller.validateApiKey({ key: 'sk_live_abc' }, 'super-secret'),
        ).resolves.toEqual({ valid: false });
        expect(service.validateApiKey).toHaveBeenCalledWith('sk_live_abc');
      } finally {
        delete process.env.ENGINE_SHARED_SECRET;
      }
    });
  });
});
