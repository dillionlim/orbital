import { AxiosResponse } from 'axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../prisma.service';
import { News } from './types/news';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Fetch Finnhub market news once per minute
   */
  @Cron('*/60 * * * * *')
  async ingestMarketNews(): Promise<void> {
    const apiKey = process.env.FINNHUB_API_KEY;
    
    if (!apiKey) {
      this.logger.warn('FINNHUB_API_KEY not configured, skipping news ingestion');
      return;
    }

    try {
      const response: AxiosResponse = await firstValueFrom(
        this.http.get<News[]>(
          'https://finnhub.io/api/v1/news',
          {
            params: {
              category: 'general',
              token: apiKey,
            },
          },
        ),
      );

      await this.prisma.news.createMany({
        data: response.data.map((item) => ({
          id: item.id,
          category: item.category,
          headline: item.headline,
          summary: item.summary,
          url: item.url,
          image: item.image,
          source: item.source,
          datetime: new Date(item.datetime * 1000),
          related: item.related
        })),
        skipDuplicates: true,
      });

      this.logger.log(`Ingested ${response.data.length} news items`);
    } catch (error) {
      this.logger.error('Failed to ingest market news', error);
    }
  }

  /**
   * Serve cached news
   */
  async getLatestNews(limit = 50) {
    try {
      return await this.prisma.news.findMany({
        orderBy: { datetime: 'desc' },
        take: limit,
      });
    } catch (error) {
      // Distinguish DB-unreachable (transient infra issue) from a real query
      // error: code 'EAI_AGAIN' / 'ENOTFOUND' / 'ETIMEDOUT' / 'P1001' all mean
      // we couldn't talk to the DB. Surface as 503 so callers can retry rather
      // than treating it as "no news exists."
      const code = (error as { code?: string })?.code ?? '';
      const transient = ['EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'P1001', 'P1002', 'P1008', 'P1017']
        .includes(code);
      if (transient) {
        this.logger.warn(`getLatestNews: DB unreachable (${code}); returning 503`);
        throw new ServiceUnavailableException({
          error: 'database_unavailable',
          code,
          message: 'News database is temporarily unreachable. Try again shortly.',
        });
      }
      throw error;
    }
  }
}
