import { HttpService } from '@nestjs/axios';
import { ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { NewsService } from './news.service';
import { PrismaService } from '../prisma.service';

// The service pulls five hard-coded RSS feeds; tests answer per-URL so a single
// feed can be made to fail without taking the others down.
const CNBC_MARKETS = 'https://www.cnbc.com/id/20910258/device/rss/rss.html';
const CNBC_FINANCE = 'https://www.cnbc.com/id/10000664/device/rss/rss.html';

const EMPTY_RSS = '<rss><channel></channel></rss>';

const RSS = `<rss><channel>
  <title>Channel title, not an item</title>
  <item>
    <title><![CDATA[Stocks rally as the Fed holds]]></title>
    <link>https://example.com/a</link>
    <description><![CDATA[<p>Equities climbed &amp; held the gains.</p>]]></description>
    <pubDate>Tue, 01 Jul 2025 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Nikkei slips at the open</title>
    <link>https://example.com/b</link>
  </item>
  <item>
    <description>Headline-less junk that must be skipped</description>
  </item>
</channel></rss>`;

describe('NewsService', () => {
  let service: NewsService;
  let httpGet: jest.Mock;
  let prisma: {
    news: {
      createMany: jest.Mock;
      findMany: jest.Mock;
    };
  };

  beforeEach(() => {
    delete process.env.FINNHUB_API_KEY;

    httpGet = jest.fn();
    // Default: every feed answers with an empty document, so a test only sees
    // the feeds it explicitly seeds.
    httpGet.mockReturnValue(of({ data: EMPTY_RSS }));

    prisma = {
      news: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(),
      },
    };

    service = new NewsService(
      { get: httpGet } as unknown as HttpService,
      prisma as unknown as PrismaService,
    );
    // The cron logs errors it swallows; keep the test output clean.
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  // Route each feed URL to its own canned response.
  function feeds(byUrl: Record<string, string>) {
    httpGet.mockImplementation((url: string) =>
      of({ data: byUrl[url] ?? EMPTY_RSS }),
    );
  }

  function rowsWritten(): Array<Record<string, unknown>> {
    const calls = prisma.news.createMany.mock.calls as unknown as [
      { data: Array<Record<string, unknown>> },
    ][];
    return calls[0][0].data;
  }

  describe('ingestMarketNews', () => {
    // The main parse path: RSS <item> blocks become News rows with CDATA and
    // HTML stripped out of the headline and summary.
    it('parses RSS items into news rows and inserts them', async () => {
      feeds({ [CNBC_MARKETS]: RSS });

      await service.ingestMarketNews();

      expect(prisma.news.createMany).toHaveBeenCalledTimes(1);
      const rows = rowsWritten();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        headline: 'Stocks rally as the Fed holds',
        summary: 'Equities climbed & held the gains.',
        url: 'https://example.com/a',
        category: 'markets',
        source: 'CNBC',
        related: '',
      });
      expect(rows[0].datetime).toEqual(
        new Date('Tue, 01 Jul 2025 12:00:00 GMT'),
      );
      expect(prisma.news.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    // An item with no title or no link can't be keyed or linked, so it is
    // dropped rather than written as a half-row.
    it('skips items missing a headline or a link', async () => {
      feeds({ [CNBC_MARKETS]: RSS });

      await service.ingestMarketNews();

      expect(rowsWritten().map((r) => r.url)).toEqual([
        'https://example.com/a',
        'https://example.com/b',
      ]);
    });

    // With no pubDate the row still needs a datetime, so it falls back to "now"
    // instead of an Invalid Date that Prisma would reject.
    it('falls back to the current time for an item with no pubDate', async () => {
      feeds({ [CNBC_MARKETS]: RSS });

      await service.ingestMarketNews();

      const row = rowsWritten().find((r) => r.url === 'https://example.com/b');
      expect((row!.datetime as Date).getTime()).not.toBeNaN();
      expect((row!.datetime as Date).getTime()).toBeCloseTo(Date.now(), -4);
    });

    // The ids are a stable hash of the link, so the same story syndicated across
    // two feeds collapses to one row before the insert.
    it('dedupes the same story appearing in two feeds', async () => {
      feeds({ [CNBC_MARKETS]: RSS, [CNBC_FINANCE]: RSS });

      await service.ingestMarketNews();

      const rows = rowsWritten();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    });

    // A per-feed try/catch means one broken feed yields nothing that cycle
    // rather than sinking the ingest for every other source.
    it('keeps ingesting when a single feed fails', async () => {
      httpGet.mockImplementation((url: string) => {
        if (url === CNBC_MARKETS) {
          return throwError(() => new Error('ECONNRESET'));
        }
        return of({ data: url === CNBC_FINANCE ? RSS : EMPTY_RSS });
      });

      await service.ingestMarketNews();

      const rows = rowsWritten();
      expect(rows).toHaveLength(2);
      expect(rows[0].source).toBe('CNBC');
      expect(rows[0].category).toBe('finance');
    });

    // Nothing parsed means nothing to write — the cycle must not fire an insert
    // with an empty data array.
    it('writes nothing when every feed fails', async () => {
      httpGet.mockReturnValue(throwError(() => new Error('network down')));

      await expect(service.ingestMarketNews()).resolves.toBeUndefined();
      expect(prisma.news.createMany).not.toHaveBeenCalled();
    });

    // Feeds that return unparseable junk (an HTML error page, say) simply yield
    // no items rather than throwing out of the cron.
    it('tolerates a feed that returns no RSS items at all', async () => {
      feeds({ [CNBC_MARKETS]: '<html><body>502 Bad Gateway</body></html>' });

      await expect(service.ingestMarketNews()).resolves.toBeUndefined();
      expect(prisma.news.createMany).not.toHaveBeenCalled();
    });

    // The cron has no caller to catch for it: a DB failure has to be logged and
    // swallowed, or it becomes an unhandled rejection in the scheduler.
    it('swallows a failed database insert', async () => {
      feeds({ [CNBC_MARKETS]: RSS });
      prisma.news.createMany.mockRejectedValue(new Error('connection refused'));

      await expect(service.ingestMarketNews()).resolves.toBeUndefined();
    });

    // Finnhub is opt-in: with no key it contributes nothing and only the keyless
    // RSS feeds are hit.
    it('skips Finnhub when no API key is configured', async () => {
      feeds({ [CNBC_MARKETS]: RSS });

      await service.ingestMarketNews();

      const urls = (httpGet.mock.calls as unknown as string[][]).map(
        (c) => c[0],
      );
      expect(urls.some((u) => u.includes('finnhub.io'))).toBe(false);
    });

    // With a key, Finnhub rows are merged in alongside RSS and their epoch-second
    // timestamps are converted to real Dates.
    it('merges Finnhub items in when a key is set', async () => {
      process.env.FINNHUB_API_KEY = 'fh_test_key';
      httpGet.mockImplementation((url: string) => {
        if (url.includes('finnhub.io')) {
          return of({
            data: [
              {
                id: 9001,
                category: 'general',
                headline: 'Dollar firms',
                summary: 'FX desks report demand.',
                url: 'https://finnhub.example/1',
                image: 'https://finnhub.example/1.png',
                source: 'Finnhub',
                datetime: 1_751_371_200,
                related: 'ES',
              },
            ],
          });
        }
        return of({ data: url === CNBC_MARKETS ? RSS : EMPTY_RSS });
      });

      try {
        await service.ingestMarketNews();
      } finally {
        delete process.env.FINNHUB_API_KEY;
      }

      const rows = rowsWritten();
      const fh = rows.find((r) => r.id === 9001);
      expect(fh).toMatchObject({
        headline: 'Dollar firms',
        source: 'Finnhub',
        related: 'ES',
      });
      expect(fh!.datetime).toEqual(new Date(1_751_371_200 * 1000));
      // The three Finnhub categories dedupe to one row; RSS still contributes.
      expect(rows).toHaveLength(3);
    });

    // A Finnhub outage must not take the keyless RSS rows down with it.
    it('still ingests RSS when Finnhub fails', async () => {
      process.env.FINNHUB_API_KEY = 'fh_test_key';
      httpGet.mockImplementation((url: string) => {
        if (url.includes('finnhub.io')) {
          return throwError(() => new Error('403 Forbidden'));
        }
        return of({ data: url === CNBC_MARKETS ? RSS : EMPTY_RSS });
      });

      try {
        await service.ingestMarketNews();
      } finally {
        delete process.env.FINNHUB_API_KEY;
      }

      expect(rowsWritten()).toHaveLength(2);
    });
  });

  describe('getLatestNews', () => {
    // The read path: newest first, bounded by the caller's limit.
    it('serves the newest cached items up to the limit', async () => {
      const items = [{ id: 1, headline: 'Stocks rally' }];
      prisma.news.findMany.mockResolvedValue(items);

      await expect(service.getLatestNews(25)).resolves.toBe(items);

      expect(prisma.news.findMany).toHaveBeenCalledWith({
        orderBy: { datetime: 'desc' },
        take: 25,
      });
    });

    // The default page size when a caller passes no limit.
    it('defaults to 50 items', async () => {
      prisma.news.findMany.mockResolvedValue([]);

      await service.getLatestNews();

      expect(prisma.news.findMany).toHaveBeenCalledWith({
        orderBy: { datetime: 'desc' },
        take: 50,
      });
    });

    // A DB we can't reach is a transient infra problem, not "there is no news" —
    // it must surface as a retryable 503 rather than an empty page.
    it('maps an unreachable database to a 503', async () => {
      const err = Object.assign(new Error('Can’t reach database server'), {
        code: 'P1001',
      });
      prisma.news.findMany.mockRejectedValue(err);

      await expect(service.getLatestNews()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    // DNS failures land on the same retryable path as Prisma's own P100x codes.
    it('maps a DNS failure to a 503 as well', async () => {
      const err = Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
        code: 'EAI_AGAIN',
      });
      prisma.news.findMany.mockRejectedValue(err);

      await expect(service.getLatestNews()).rejects.toMatchObject({
        response: { error: 'database_unavailable', code: 'EAI_AGAIN' },
      });
    });

    // A genuine query error is a bug, not a blip: it must not be disguised as a
    // transient 503 that clients keep retrying.
    it('rethrows a non-transient query error untouched', async () => {
      const err = Object.assign(new Error('column does not exist'), {
        code: 'P2022',
      });
      prisma.news.findMany.mockRejectedValue(err);

      await expect(service.getLatestNews()).rejects.toThrow(
        'column does not exist',
      );
      await expect(service.getLatestNews()).rejects.not.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
