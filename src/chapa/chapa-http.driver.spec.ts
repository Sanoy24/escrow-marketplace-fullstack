import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { AppConfig } from '../config/configuration';
import { ChapaHttpDriver } from './chapa-http.driver';

const WEBHOOK_SECRET = 'test-webhook-secret';

describe('ChapaHttpDriver.verifyWebhookSignature', () => {
  let driver: ChapaHttpDriver;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChapaHttpDriver,
        {
          provide: ConfigService,
          useValue: {
            get: (key: keyof AppConfig) => {
              if (key === 'chapa')
                return { secretKey: 'test-secret', webhookSecret: WEBHOOK_SECRET };
              throw new Error(`Unexpected config key in test: ${key}`);
            },
          },
        },
      ],
    }).compile();
    driver = moduleRef.get(ChapaHttpDriver);
  });

  function sign(body: string): string {
    return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  }

  it('accepts a signature computed with the correct secret', () => {
    const body = JSON.stringify({ event: 'charge.success', tx_ref: 'abc123' });
    expect(driver.verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = JSON.stringify({ event: 'charge.success', tx_ref: 'abc123' });
    const wrongSignature = createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    expect(driver.verifyWebhookSignature(body, wrongSignature)).toBe(false);
  });

  it('rejects a signature computed over a different body (tampered payload)', () => {
    const originalBody = JSON.stringify({ event: 'charge.success', amount: '100' });
    const tamperedBody = JSON.stringify({ event: 'charge.success', amount: '999999' });
    expect(driver.verifyWebhookSignature(tamperedBody, sign(originalBody))).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = JSON.stringify({ event: 'charge.success' });
    expect(driver.verifyWebhookSignature(body, undefined)).toBe(false);
  });
});
