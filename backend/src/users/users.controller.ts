import { Controller, Post, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { Request } from 'express';
import { User, ApiKey } from '@prisma/client';

interface AuthClaims {
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
    claims: AuthClaims;
  };
}

@Controller('users')
@UseGuards(SupabaseAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Logout is handled entirely client-side with Supabase (supabase.auth.signOut
  // clears the localStorage session), so there's no server endpoint to revoke.

  @Post('sync')
  async syncUser(
    @Req() req: AuthenticatedRequest,
  ): Promise<User & { apiKey: ApiKey | null }> {
    const userId = req.auth.userId;
    const claims = req.auth.claims || {};
    const email = claims.email || `${userId}@users.noreply`;
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
