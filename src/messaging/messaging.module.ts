import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MessagingController } from './messaging.controller';
import { MessagingGateway } from './messaging.gateway';
import { MessagingService } from './messaging.service';

@Module({
  // AuthModule for its exported JwtModule — the gateway verifies the same
  // access tokens the HTTP JwtStrategy does, via the same secret/config,
  // rather than registering a second JwtService against a duplicate config.
  imports: [AuthModule],
  controllers: [MessagingController],
  providers: [MessagingGateway, MessagingService],
})
export class MessagingModule {}
