import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ESCROW_AUTO_RELEASE_QUEUE, type EscrowAutoReleaseJobData } from './escrow.constants';
import { EscrowService } from './escrow.service';

@Processor(ESCROW_AUTO_RELEASE_QUEUE)
export class AutoReleaseProcessor extends WorkerHost {
  constructor(private readonly escrowService: EscrowService) {
    super();
  }

  async process(job: Job<EscrowAutoReleaseJobData>): Promise<void> {
    await this.escrowService.autoRelease(job.data.escrowTransactionId);
  }
}
