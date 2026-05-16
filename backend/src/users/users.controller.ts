import { Controller, Post, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { Request } from 'express';
import { User, ApiKey } from '@prisma/client';

interface AuthenticatedRequest extends Request {
  auth: {
    userId: string;
    sessionId: string;
    claims: any;
  };
}

@Controller('users')
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
