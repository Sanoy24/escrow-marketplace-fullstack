import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatSantimToEtb } from '../common/money/parse-etb';
import type { AppConfig } from '../config/configuration';
import {
  type ChapaService,
  type CreateTransferParams,
  type CreateTransferResult,
  type InitializeTransactionParams,
  type InitializeTransactionResult,
  type RefundParams,
  type RefundResult,
} from './chapa.interface';

const CHAPA_BASE_URL = 'https://api.chapa.co/v1';

interface ChapaInitializeResponse {
  data?: { checkout_url?: string };
}

interface ChapaTransferResponse {
  data?: { reference?: string; chapa_reference?: string };
}

interface ChapaRefundResponse {
  data?: { ref_id?: string };
}

/**
 * The real Chapa HTTP client — sandbox during Phase 4 (docs/ARCHITECTURE.md
 * §5), never live mode until legal review clears real money. e2e tests
 * bind a fake over CHAPA_SERVICE instead of this class, so nothing in this
 * file ever runs against the network in CI.
 */
@Injectable()
export class ChapaHttpDriver implements ChapaService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppConfig, true>) {}

  async initializeTransaction(
    params: InitializeTransactionParams,
  ): Promise<InitializeTransactionResult> {
    const res = await fetch(`${CHAPA_BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        amount: formatSantimToEtb(params.amountSantim),
        currency: 'ETB',
        tx_ref: params.txRef,
        email: params.email,
        first_name: params.firstName,
        last_name: params.lastName,
        return_url: params.returnUrl,
      }),
    });
    const body = (await res.json()) as ChapaInitializeResponse;
    const checkoutUrl = body.data?.checkout_url;
    if (!res.ok || !checkoutUrl) {
      throw new InternalServerErrorException('Chapa transaction initialization failed.');
    }
    return { checkoutUrl };
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const expected = createHmac('sha256', this.config.get('chapa', { infer: true }).webhookSecret)
      .update(rawBody)
      .digest('hex');
    const suppliedBytes = Buffer.from(signatureHeader);
    const expectedBytes = Buffer.from(expected);
    return (
      suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
    );
  }

  async createTransfer(params: CreateTransferParams): Promise<CreateTransferResult> {
    const res = await fetch(`${CHAPA_BASE_URL}/transfers`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        account_number: params.accountNumber,
        account_name: params.accountName,
        amount: formatSantimToEtb(params.amountSantim),
        bank_code: params.bankCode,
        reference: params.reference,
        currency: 'ETB',
      }),
    });
    const body = (await res.json()) as ChapaTransferResponse;
    const transferRef = body.data?.chapa_reference ?? body.data?.reference;
    if (!res.ok || !transferRef) {
      throw new InternalServerErrorException('Chapa transfer failed.');
    }
    return { transferRef };
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    const res = await fetch(`${CHAPA_BASE_URL}/refund/${encodeURIComponent(params.chapaTxRef)}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ reason: params.reason }),
    });
    const body = (await res.json()) as ChapaRefundResponse;
    const refundRef = body.data?.ref_id;
    if (!res.ok || !refundRef) {
      throw new InternalServerErrorException('Chapa refund failed.');
    }
    return { refundRef };
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.get('chapa', { infer: true }).secretKey}`,
      'Content-Type': 'application/json',
    };
  }
}
