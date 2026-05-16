import {
  Controller,
  Post,
  Get,
  Req,
  Delete,
  Param,
  Body,
  Headers,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { Request } from 'express';

interface ClerkClaims {
  email?: string;
  username?: string;
  preferred_username?: string;
}

interface AuthenticatedRequest extends Request {
  auth: {
    userId: string;
    sessionId: string;
    claims: ClerkClaims;
  };
}

@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  async createApiKey(@Req() req: AuthenticatedRequest) {
    const userId = req.auth.userId;
    const email = req.auth.claims?.email || `user_${userId}@clerk.dev`;
    const username =
      req.auth.claims?.username || req.auth.claims?.preferred_username;

    return await this.apiKeyService.createApiKey(userId, email, username);
  }

  @Get()
  async getApiKeys(@Req() req: AuthenticatedRequest) {
    const userId = req.auth.userId;
    return await this.apiKeyService.getApiKeys(userId);
  }

  // POST + body + shared-secret header. Used to be GET ?key=… but:
  //   1. URLs end up in access logs / browser history; secrets shouldn't.
  //   2. The endpoint is unauthenticated and hits Prisma findUnique on every
  //      call — without a gate, anyone can mount a cheap DB-DoS amplifier.
  // ENGINE_SHARED_SECRET in env is checked when set. Empty / unset = open
  // (dev-friendly), but a startup warning is logged in main.ts.
  @Post('validate')
  async validateApiKey(
    @Body() body: { key?: string },
    @Headers('x-engine-secret') engineSecret: string,
  ) {
    const expected = process.env.ENGINE_SHARED_SECRET;
    if (expected && engineSecret !== expected) {
      throw new HttpException(
        'engine secret missing or invalid',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!body?.key || typeof body.key !== 'string') {
      throw new HttpException('missing key', HttpStatus.BAD_REQUEST);
    }
    return await this.apiKeyService.validateApiKey(body.key);
  }

  @Delete(':id')
  async deleteApiKey(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.auth.userId;
    return await this.apiKeyService.deleteApiKey(id, userId);
  }
}
