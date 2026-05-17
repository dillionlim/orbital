import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { ConfigService } from '@nestjs/config';
import { StrategyOptions } from 'passport-jwt';

interface JwtPayload {
  sub: string;
  [key: string]: any;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
    const issuer = configService.get<string>('AUTH0_ISSUER_URL');
    const audience = configService.get<string>('AUTH0_AUDIENCE');

    const strategyOptions: StrategyOptions = {
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${issuer}.well-known/jwks.json`,
      }),
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      audience: audience,
      issuer: issuer,
      algorithms: ['RS256'],
    };
    super(strategyOptions);
  }

  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
