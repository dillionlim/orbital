import {
  Controller,
  Post,
  Get,
  UseGuards,
  Req,
  Delete,
  Param,
  Query,
} from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
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
  @UseGuards(ClerkAuthGuard)
  async createApiKey(@Req() req: AuthenticatedRequest) {
    const userId = req.auth.userId;
    const email = req.auth.claims?.email || `user_${userId}@clerk.dev`;
    const username =
      req.auth.claims?.username || req.auth.claims?.preferred_username;

    return await this.apiKeyService.createApiKey(userId, email, username);
  }

  @Get()
  @UseGuards(ClerkAuthGuard)
  async getApiKeys(@Req() req: AuthenticatedRequest) {
    const userId = req.auth.userId;
    return await this.apiKeyService.getApiKeys(userId);
  }

  @Get('validate')
  async validateApiKey(@Query('key') key: string) {
    return await this.apiKeyService.validateApiKey(key);
  }

  @Delete(':id')
  @UseGuards(ClerkAuthGuard)
  async deleteApiKey(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.auth.userId;
    return await this.apiKeyService.deleteApiKey(id, userId);
  }
}
