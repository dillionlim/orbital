import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma.service';
import { ApiKeyService } from '../api-keys/api-key.service';
import { User, ApiKey } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private apiKeyService: ApiKeyService,
  ) {}

  async syncUser(
    clerkId: string,
    email: string,
    username?: string,
    firstName?: string,
    lastName?: string,
  ): Promise<User & { apiKey: ApiKey | null }> {
    // Schema models User.apiKey as a 1:1 optional relation (ApiKey.userId is @unique).
    let user = await this.prisma.user.findUnique({
      where: { clerkId },
      include: { apiKey: true },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          clerkId,
          email,
          username,
          firstName,
          lastName,
        },
        include: { apiKey: true },
      });
    } else if (
      user.email !== email ||
      user.username !== username ||
      user.firstName !== firstName ||
      user.lastName !== lastName
    ) {
      user = await this.prisma.user.update({
        where: { clerkId },
        data: {
          email,
          username,
          firstName,
          lastName,
        },
        include: { apiKey: true },
      });
    }

    // Ensure exactly one API key, ATOMICALLY. Calling apiKeyService.createApiKey
    // here was wrong: it deletes the existing key first, so two concurrent
    // /users/sync calls (e.g. from React Strict Mode double-firing in dev) would
    // delete each other's freshly-inserted keys and the user would end every
    // page load with a different key. `upsert` with `update: {}` is a true
    // no-op when a key exists — the first create wins, races resolve cleanly.
    if (!user.apiKey) {
      await this.prisma.apiKey.upsert({
        where: { userId: user.id },
        update: {},
        create: {
          key: `sk_live_${crypto.randomBytes(16).toString('hex')}`,
          name: 'Default API Key',
          userId: user.id,
        },
      });
      user = await this.prisma.user.findUnique({
        where: { clerkId },
        include: { apiKey: true },
      });
    }

    if (!user) {
      throw new Error('User could not be created or found');
    }

    return user;
  }

  // Map a set of user ids -> display username, for the leaderboard. Returns only
  // the username (no other profile detail).
  async getUsernames(ids: string[]): Promise<Record<string, string>> {
    if (!ids.length) return {};
    const users = await this.prisma.user.findMany({
      where: { clerkId: { in: ids } },
      select: { clerkId: true, username: true },
    });
    const out: Record<string, string> = {};
    for (const u of users) out[u.clerkId] = u.username ?? '';
    return out;
  }
}
