import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001'], // Allow both for dev
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // POST /api-keys/validate is unauthenticated — without a shared secret
  // anyone can hammer the endpoint and cheaply DoS Prisma's findUnique.
  // We don't hard-require it (single-host dev needs to keep working out of
  // the box) but loudly warn so production deployments don't ship without it.
  if (!process.env.ENGINE_SHARED_SECRET) {
    Logger.warn(
      'ENGINE_SHARED_SECRET is not set: /api-keys/validate is open to ' +
        'unauthenticated callers. Set this in production to gate the endpoint.',
      'Bootstrap',
    );
  }

  await app.listen(3010);
}
void bootstrap();
