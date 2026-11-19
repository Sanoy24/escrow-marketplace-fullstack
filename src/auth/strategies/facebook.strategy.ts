import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile, type VerifyFunction } from 'passport-facebook';
import type { AppConfig } from '../../config/configuration';
import type { SocialProfile } from '../auth.service';

type Done = Parameters<VerifyFunction>[3];

@Injectable()
export class FacebookStrategy extends PassportStrategy(Strategy, 'facebook') {
  constructor(configService: ConfigService<AppConfig, true>) {
    const { facebookClientId, facebookClientSecret, callbackBaseUrl } = configService.get('oauth', {
      infer: true,
    });
    super({
      clientID: facebookClientId,
      clientSecret: facebookClientSecret,
      callbackURL: `${callbackBaseUrl}/auth/facebook/callback`,
      // Facebook returns no profile fields at all unless explicitly asked.
      profileFields: ['id', 'emails', 'displayName'],
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: Profile, done: Done): void {
    const result: SocialProfile = {
      provider: 'facebook',
      providerId: profile.id,
      email: profile.emails?.[0]?.value,
      name: profile.displayName,
    };
    done(null, result);
  }
}
