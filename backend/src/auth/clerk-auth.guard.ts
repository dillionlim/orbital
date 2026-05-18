import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ClerkExpressWithAuth, WithAuthProp } from '@clerk/clerk-sdk-node';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';

type AuthenticatedRequest = WithAuthProp<Request>;

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name);

  constructor(private configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const middleware = ClerkExpressWithAuth({
      // Options if needed
    });

    await new Promise<void>((resolve, reject) => {
      void middleware(
        request as unknown as Parameters<typeof middleware>[0],
        response as unknown as Parameters<typeof middleware>[1],
        (err: any) => {
          if (err) {
            this.logger.error('Clerk authentication error:', err);
            return void reject(new Error(String(err)));
          }
          void resolve();
        },
      );
    });

    return !!request.auth?.userId;
  }
}
