import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { AppConfig } from '../config/configuration';
import { QueueModule } from '../queue/queue.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FacebookStrategy } from './strategies/facebook.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const { accessSecret, accessTtlSeconds } = config.get('jwt', { infer: true });
        return { secret: accessSecret, signOptions: { expiresIn: accessTtlSeconds } };
      },
    }),
    QueueModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, GoogleStrategy, FacebookStrategy],
  // JwtModule exported so other modules (e.g. MessagingModule's WS gateway)
  // can verify the same access tokens without re-registering their own
  // JwtService against a second copy of the same secret/TTL config.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
