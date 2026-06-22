import { Controller, Post, UseGuards, Req, Logger } from '@nestjs/common';
import { UsersService } from './users.service';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { clerkClient } from '@clerk/clerk-sdk-node';
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
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly usersService: UsersService) {}

  // Formally revoke the caller's Clerk session via the Backend API (uses the
  // secret key). The dashboard calls this on logout because a Clerk *development*
  // instance can't complete the client-side signOut on a deployed domain — this
  // invalidates the session token server-side regardless.
  @Post('logout')
  async logout(@Req() req: AuthenticatedRequest): Promise<{ revoked: boolean }> {
    try {
      await clerkClient.sessions.revokeSession(req.auth.sessionId);
      return { revoked: true };
    } catch (err) {
      this.logger.warn(`session revoke failed: ${(err as Error).message}`);
      return { revoked: false };
    }
  }

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
