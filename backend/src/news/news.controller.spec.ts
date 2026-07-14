import { NewsController } from './news.controller';
import { NewsService } from './news.service';

describe('NewsController', () => {
  let controller: NewsController;
  let service: { getLatestNews: jest.Mock };

  beforeEach(() => {
    service = { getLatestNews: jest.fn().mockResolvedValue([]) };
    controller = new NewsController(service as unknown as NewsService);
  });

  // The limit the service actually sees, after the route's clamp.
  function limitPassed(): number {
    const calls = service.getLatestNews.mock.calls as unknown as [number][];
    return calls.at(-1)![0];
  }

  describe('GET /news', () => {
    // The read path hands the cached items straight back.
    it('returns the cached news items', async () => {
      const items = [{ id: 1, headline: 'Stocks rally' }];
      service.getLatestNews.mockResolvedValue(items);

      await expect(controller.getNews()).resolves.toBe(items);
      expect(limitPassed()).toBe(50);
    });

    // A sane in-range limit passes through untouched.
    it('honours a limit inside the allowed range', async () => {
      await controller.getNews('120');
      expect(limitPassed()).toBe(120);
    });

    // Without an upper bound, `?limit=1000000` would have Prisma materialise the
    // whole news table into memory — a cheap DoS.
    it('clamps an absurdly large limit to 200', async () => {
      await controller.getNews('1000000');
      expect(limitPassed()).toBe(200);
    });

    // 200 is inclusive — the boundary itself is allowed.
    it('allows exactly 200', async () => {
      await controller.getNews('200');
      expect(limitPassed()).toBe(200);
    });

    // 1 is the lower bound; anything below it (0, negatives) is nonsense and
    // falls back to the default rather than asking Prisma for `take: -5`.
    it('allows exactly 1 but falls back to the default below it', async () => {
      await controller.getNews('1');
      expect(limitPassed()).toBe(1);

      await controller.getNews('0');
      expect(limitPassed()).toBe(50);

      await controller.getNews('-5');
      expect(limitPassed()).toBe(50);
    });

    // Garbage and Infinity are not finite numbers, so they take the default.
    it('falls back to the default for non-numeric or infinite limits', async () => {
      await controller.getNews('abc');
      expect(limitPassed()).toBe(50);

      await controller.getNews('Infinity');
      expect(limitPassed()).toBe(50);
    });

    // Prisma's `take` must be an integer, so a fractional limit is floored.
    it('floors a fractional limit to an integer', async () => {
      await controller.getNews('10.9');
      expect(limitPassed()).toBe(10);
    });
  });
});
