import { Controller, Post, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { Request } from 'express';
import { User, ApiKey } from '@prisma/client';

interface ClerkClaims {
  email?: string;
  username?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
}

interface AuthenticatedRequest extends Request {
  auth: {
    userId: string;
    sessionId: string;
    claims: ClerkClaims;
  };
}

@Controller('users')
@UseGuards(ClerkAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('sync')
  async syncUser(
    @Req() req: AuthenticatedRequest,
  ): Promise<User & { apiKey: ApiKey | null }> {
    const userId = req.auth.userId;
    const claims = req.auth.claims || {};
    const email = claims.email || `user_${userId}@clerk.dev`; // Fallback if email not in claims
    const username = claims.username || claims.preferred_username;
    const firstName = claims.given_name;
    const lastName = claims.family_name;

    return await this.usersService.syncUser(
      userId,
      email,
      username,
      firstName,
      lastName,
    );
  }
}
