export const CHAPA_SERVICE = Symbol('CHAPA_SERVICE');

export interface InitializeTransactionParams {
  amountSantim: bigint;
  txRef: string;
  email: string;
  firstName?: string;
  lastName?: string;
  returnUrl?: string;
}

export interface InitializeTransactionResult {
  checkoutUrl: string;
}

export interface CreateTransferParams {
  amountSantim: bigint;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /** Our own reference for this payout — distinct from the transfer id Chapa returns. */
  reference: string;
}

export interface CreateTransferResult {
  transferRef: string;
}

export interface RefundParams {
  chapaTxRef: string;
  reason: string;
}

export interface RefundResult {
  refundRef: string;
}

/**
 * Abstraction over Chapa's HTTP API, so ChapaHttpDriver (the real
 * implementation) drops in behind ChapaModule's binding, and e2e tests
 * swap it for a fake that never hits the network — same pattern as
 * SmsService/SMS_SERVICE (src/sms/sms.interface.ts).
 *
 * Deliberately narrow: only the three Chapa calls Phase 4 escrow needs.
 * No subaccount/split-payment method — the corrected design
 * (docs/ARCHITECTURE.md §5) never attaches a subaccount to a charge.
 */
export interface ChapaService {
  /** Plain charge, no subaccount attached — funds land in the platform's own Chapa balance. */
  initializeTransaction(params: InitializeTransactionParams): Promise<InitializeTransactionResult>;

  /**
   * Verifies a webhook request's signature against the raw request body.
   * Must run before the payload is parsed or the database is touched
   * (docs/CODE_GUIDELINES.md §3) — an unverified payload is
   * attacker-controlled input.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean;

  /** Pays a seller's bank account on demand from the platform's Chapa balance. Only called on release. */
  createTransfer(params: CreateTransferParams): Promise<CreateTransferResult>;

  /** Refunds the buyer against the original charge. Only called when a dispute resolves in the buyer's favor. */
  refund(params: RefundParams): Promise<RefundResult>;
}
