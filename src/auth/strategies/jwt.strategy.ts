import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AccessTokenPayload } from '../auth.service';
import type { AppConfig } from '../../config/configuration';

export interface AuthenticatedUser {
  id: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService<AppConfig, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get('jwt', { infer: true }).accessSecret,
      ignoreExpiration: false,
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    // Defense in depth: nothing today mints a non-"access" token with this
    // secret (refresh tokens are opaque, not JWTs — see token.util.ts), but
    // this closes the door on a future token type ever being replayed here.
    // See docs/CODE_GUIDELINES.md and the reference project's equivalent check.
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type.');
    }
    return { id: payload.sub };
  }
}
