import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

import { NewsController } from './news.controller';
import { NewsService } from './news.service';
import { PrismaService } from '../prisma.service';


@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [NewsController],
  providers: [NewsService, PrismaService],
})
export class NewsModule {}
