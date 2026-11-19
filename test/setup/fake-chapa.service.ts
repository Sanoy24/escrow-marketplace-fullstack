import { Injectable } from '@nestjs/common';
import type {
  ChapaService,
  CreateTransferParams,
  CreateTransferResult,
  InitializeTransactionParams,
  InitializeTransactionResult,
  RefundParams,
  RefundResult,
} from '../../src/chapa/chapa.interface';

/**
 * Test double bound over CHAPA_SERVICE in e2e tests — nothing in the
 * escrow e2e suite ever calls the real Chapa network, same pattern as
 * FakeSmsService over SMS_SERVICE. Signature verification always passes
 * here: the real HMAC logic has its own dedicated unit test
 * (src/chapa/chapa-http.driver.spec.ts), so this fake stays focused on
 * the business-logic flows the e2e suite is actually exercising.
 */
@Injectable()
export class FakeChapaService implements ChapaService {
  readonly initializedTransactions: InitializeTransactionParams[] = [];
  readonly transfers: CreateTransferParams[] = [];
  readonly refunds: RefundParams[] = [];

  initializeTransaction(params: InitializeTransactionParams): Promise<InitializeTransactionResult> {
    this.initializedTransactions.push(params);
    return Promise.resolve({ checkoutUrl: `https://checkout.fake-chapa.test/${params.txRef}` });
  }

  verifyWebhookSignature(): boolean {
    return true;
  }

  createTransfer(params: CreateTransferParams): Promise<CreateTransferResult> {
    this.transfers.push(params);
    return Promise.resolve({ transferRef: `fake_transfer_${this.transfers.length}` });
  }

  refund(params: RefundParams): Promise<RefundResult> {
    this.refunds.push(params);
    return Promise.resolve({ refundRef: `fake_refund_${this.refunds.length}` });
  }
}
