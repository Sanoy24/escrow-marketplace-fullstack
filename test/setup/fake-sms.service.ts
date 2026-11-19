import { Injectable } from '@nestjs/common';
import type { SmsService } from '../../src/sms/sms.interface';

export interface SentSms {
  to: string;
  body: string;
}

/**
 * Test double bound over SMS_SERVICE in e2e tests. The OTP code is stored
 * only as an argon2 hash (see db/schema/otp-codes.ts), so there is no way
 * to read it back from the database even in a test — this captures what
 * was actually "sent", the same signal a real SMS provider callback or the
 * dev console log would give a human tester.
 */
@Injectable()
export class FakeSmsService implements SmsService {
  readonly sent: SentSms[] = [];

  send(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
    return Promise.resolve();
  }

  lastCode(): string {
    const last = this.sent.at(-1);
    if (!last) throw new Error('No SMS was sent');
    const match = /\b(\d{6})\b/.exec(last.body);
    const code = match?.[1];
    if (!code) throw new Error(`Could not find a 6-digit code in: ${last.body}`);
    return code;
  }

  /**
   * OTP delivery goes through a real BullMQ queue (see src/queue), so the
   * worker processes it asynchronously — nothing guarantees `sent` already
   * has the message the instant the HTTP request that enqueued it resolves.
   * Callers must capture `sms.sent.length` *before* triggering the request
   * and pass it here, rather than reading `lastCode()` immediately, or the
   * assertion races the queue and is flaky under load.
   */
  async waitForCodeAfter(previousCount: number, timeoutMs = 3000): Promise<string> {
    const start = Date.now();
    while (this.sent.length <= previousCount) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for a queued SMS to be delivered`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.lastCode();
  }
}
