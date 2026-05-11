import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = Number(process.env.PORT) || 3010;
  await app.listen(port);
  console.log(`[backend] listening on :${port}`);
}
void bootstrap();
