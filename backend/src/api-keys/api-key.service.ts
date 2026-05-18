import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class ApiKeyService {
  constructor(private prisma: PrismaService) {}

  async createApiKey(clerkId: string, email: string, username?: string) {
    // 1. Ensure User exists
    let user = await this.prisma.user.findUnique({
      where: { clerkId },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          clerkId,
          email,
          username,
        },
      });
    } else if (username && user.username !== username) {
      // Update username if it changed or was missing
      user = await this.prisma.user.update({
        where: { clerkId },
        data: { username },
      });
    }

    // 2. Generate API Key
    const key = `sk_live_${crypto.randomBytes(16).toString('hex')}`;

    // 3. Ensure single API key per user: delete existing keys before creating new one
    await this.prisma.apiKey.deleteMany({
      where: { userId: user.id },
    });

    // 4. Save to DB
    const apiKey = await this.prisma.apiKey.create({
      data: {
        key,
        name: 'Default API Key',
        userId: user.id,
      },
    });

    return apiKey;
  }

  async getApiKeys(clerkId: string) {
    // Schema is 1:1 (User.apiKey is singular). Return as a single-element array
    // so the existing frontend contract (apiKeys[0].key) keeps working.
    const user = await this.prisma.user.findUnique({
      where: { clerkId },
      include: { apiKey: true },
    });
    if (!user || !user.apiKey) return [];
    return [user.apiKey];
  }

  async deleteApiKey(id: string, clerkId: string) {
    // Verify ownership
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id },
      include: { user: true },
    });

    if (apiKey && apiKey.user.clerkId === clerkId) {
      return this.prisma.apiKey.delete({
        where: { id },
      });
    }

    throw new Error('Unauthorized or API Key not found');
  }

  async validateApiKey(
    key: string,
  ): Promise<{ valid: boolean; userId?: string }> {
    if (!key || !key.startsWith('sk_live_')) {
      return { valid: false };
    }

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { key },
      include: { user: true },
    });

    if (!apiKey || !apiKey.isActive) return { valid: false };
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return { valid: false };
    }

    return { valid: true, userId: apiKey.user.clerkId };
  }
}
