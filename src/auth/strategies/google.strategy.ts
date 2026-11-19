import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';
import type { AppConfig } from '../../config/configuration';
import type { SocialProfile } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService<AppConfig, true>) {
    const { googleClientId, googleClientSecret, callbackBaseUrl } = configService.get('oauth', {
      infer: true,
    });
    super({
      clientID: googleClientId,
      clientSecret: googleClientSecret,
      callbackURL: `${callbackBaseUrl}/auth/google/callback`,
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const result: SocialProfile = {
      provider: 'google',
      providerId: profile.id,
      email: profile.emails?.[0]?.value,
      name: profile.displayName,
    };
    done(null, result);
  }
}
