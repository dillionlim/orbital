import { INestApplication, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ApiKeyController } from '../src/api-keys/api-key.controller';
import { ApiKeyService } from '../src/api-keys/api-key.service';

describe('ApiKeyController (e2e)', () => {
  let app: INestApplication;
  let apiKeyService: { validateApiKey: jest.Mock };
  const originalSecret = process.env.ENGINE_SHARED_SECRET;

  beforeEach(async () => {
    apiKeyService = {
      validateApiKey: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeyController],
      providers: [{ provide: ApiKeyService, useValue: apiKeyService }],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    process.env.ENGINE_SHARED_SECRET = originalSecret;
    await app.close();
  });

  // Verifies the engine validation endpoint enforces its shared secret.
  it('requires the engine shared secret when configured', async () => {
    process.env.ENGINE_SHARED_SECRET = 'engine-secret';

    await request(app.getHttpServer())
      .post('/api-keys/validate')
      .set('x-engine-secret', 'wrong-secret')
      .send({ key: 'sk_live_valid' })
      .expect(HttpStatus.UNAUTHORIZED);

    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  // Checks malformed validation requests fail at the controller boundary.
  it('rejects requests without a key before hitting the service', async () => {
    process.env.ENGINE_SHARED_SECRET = 'engine-secret';

    await request(app.getHttpServer())
      .post('/api-keys/validate')
      .set('x-engine-secret', 'engine-secret')
      .send({})
      .expect(HttpStatus.BAD_REQUEST);

    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  // Covers the successful engine-facing API-key validation flow.
  it('validates a key through the service for the trading engine', async () => {
    process.env.ENGINE_SHARED_SECRET = 'engine-secret';
    apiKeyService.validateApiKey.mockResolvedValue({
      valid: true,
      userId: 'auth_user_1',
    });

    await request(app.getHttpServer())
      .post('/api-keys/validate')
      .set('x-engine-secret', 'engine-secret')
      .send({ key: 'sk_live_valid' })
      .expect(HttpStatus.CREATED)
      .expect({ valid: true, userId: 'auth_user_1' });

    expect(apiKeyService.validateApiKey).toHaveBeenCalledWith('sk_live_valid');
  });
});
