import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { ApiKeyModule } from './api-keys/api-key.module';
import { UsersModule } from './users/users.module';
import { NewsModule } from './news/news.module';
import { IndexPricesModule } from './index-prices/index-prices.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    ApiKeyModule,
    UsersModule,
    NewsModule,
    IndexPricesModule
  ],
  controllers: [AppController],
  providers: [PrismaService],
})
export class AppModule {}
