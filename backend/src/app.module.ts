import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { ApiKeyModule } from './api-keys/api-key.module';
import { TradingModule } from './trading/trading.module';
import { UsersModule } from './users/users.module';
import { NewsModule } from './news/news.module';
import { IndexPricesModule } from './index-prices/index-prices.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    ApiKeyModule,
    TradingModule,
    UsersModule,
    NewsModule,
    IndexPricesModule
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
