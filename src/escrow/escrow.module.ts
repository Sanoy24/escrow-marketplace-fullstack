import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ChapaModule } from '../chapa/chapa.module';
import { OrdersModule } from '../orders/orders.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { AutoReleaseProcessor } from './auto-release.processor';
import { ESCROW_AUTO_RELEASE_QUEUE } from './escrow.constants';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: ESCROW_AUTO_RELEASE_QUEUE }),
    ChapaModule,
    OrdersModule,
    ReviewsModule,
  ],
  controllers: [EscrowController],
  providers: [EscrowService, AutoReleaseProcessor],
  exports: [EscrowService],
})
export class EscrowModule {}
