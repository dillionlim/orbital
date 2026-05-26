import { Controller, Get, Query } from '@nestjs/common';
import { NewsService } from './news.service';

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  async getNews(@Query('limit') limit?: string) {
    // Clamp 1..200. Without an upper bound, `?limit=1000000` would have
    // Prisma materialise the whole news table into memory — cheap DoS.
    let n = limit ? Number(limit) : 50;
    if (!Number.isFinite(n) || n < 1) n = 50;
    if (n > 200) n = 200;
    return this.newsService.getLatestNews(Math.floor(n));
  }
}
