import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import {
  chapaWebhookEvents,
  disputes,
  escrowTransactions,
  users,
  type EscrowTransaction,
} from '../../db/schema';
import { CHAPA_SERVICE, type ChapaService } from '../chapa/chapa.interface';
import { parseEtbToSantim } from '../common/money/parse-etb';
import { requireVerificationLevel } from '../common/verification/require-verification-level';
import type { AppConfig } from '../config/configuration';
import { DrizzleService, type Tx } from '../db/drizzle.service';
import { OrdersService } from '../orders/orders.service';
import { CreateEscrowDto } from './dto/create-escrow.dto';
import { RaiseDisputeDto } from './dto/raise-dispute.dto';
import {
  ESCROW_AUTO_RELEASE_QUEUE,
  ESCROW_PLATFORM_FEE_BPS,
  ESCROW_PLATFORM_FEE_BPS_BUSINESS,
} from './escrow.constants';

interface ChapaWebhookPayload {
  event?: string;
  tx_ref?: string;
  reference?: string;
  status?: string;
  amount?: string;
}

@Injectable()
export class EscrowService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly ordersService: OrdersService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(CHAPA_SERVICE) private readonly chapa: ChapaService,
    @InjectQueue(ESCROW_AUTO_RELEASE_QUEUE) private readonly autoReleaseQueue: Queue,
  ) {}

  /**
   * Buyer-initiated. Requires the seller to be at least ID-verified
   * (docs/ARCHITECTURE.md §6 — "selling via escrow requires ID
   * verification"). Charges a plain Chapa transaction with no subaccount
   * attached — see the corrected design note in ARCHITECTURE.md §5.
   */
  async initiate(
    buyerId: string,
    dto: CreateEscrowDto,
  ): Promise<{ escrowTransaction: EscrowTransaction; checkoutUrl: string }> {
    const order = await this.ordersService.getForParticipant(dto.orderId, buyerId);
    if (order.buyerId !== buyerId) {
      throw new BadRequestException('Only the buyer can initiate escrow on this order.');
    }

    const [seller] = await this.drizzle.db
      .select({ verificationLevel: users.verificationLevel })
      .from(users)
      .where(eq(users.id, order.sellerId))
      .limit(1);
    if (!seller) {
      throw new ForbiddenException('This seller is not yet verified to sell via escrow.');
    }
    requireVerificationLevel(
      seller.verificationLevel,
      'id',
      'This seller is not yet verified to sell via escrow.',
    );

    const [buyer] = await this.drizzle.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, buyerId))
      .limit(1);

    const chapaTxRef = `escrow_${randomUUID()}`;
    const checkout = await this.chapa.initializeTransaction({
      amountSantim: order.totalSantim,
      txRef: chapaTxRef,
      // Chapa requires an email; users authenticate by phone in this
      // product and email is optional (db/schema/users.ts) — fall back to
      // a deterministic placeholder rather than failing initiation for a
      // buyer who never set one.
      email: buyer?.email ?? `${buyerId}@buyers.gebeya.local`,
      // Where Chapa's checkout page sends the buyer's browser back to
      // after payment — client-side only, not the source of truth for
      // `held` (the webhook is). Without this Chapa has nowhere
      // configured to return to.
      returnUrl: `${this.config.get('frontendOrigin', { infer: true })}/orders/${order.id}`,
    });

    const [escrowTransaction] = await this.drizzle.db
      .insert(escrowTransactions)
      .values({
        orderId: order.id,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        amountSantim: order.totalSantim,
        chapaTxRef,
      })
      .returning();
    if (!escrowTransaction) {
      throw new Error('Failed to create escrow transaction.');
    }
    return { escrowTransaction, checkoutUrl: checkout.checkoutUrl };
  }

  /**
   * docs/CODE_GUIDELINES.md §3, in order: verify signature first, dedupe
   * on the provider's event id via a unique constraint (not an
   * `if (exists)` check), process in a transaction, never trust the
   * payload's amount. Returns 2xx to the caller only after this resolves.
   */
  async handleWebhook(rawBody: string, signatureHeader: string | undefined): Promise<void> {
    if (!this.chapa.verifyWebhookSignature(rawBody, signatureHeader)) {
      throw new ForbiddenException('Invalid webhook signature.');
    }

    const payload = JSON.parse(rawBody) as ChapaWebhookPayload;
    const eventReference = payload.reference;
    const txRef = payload.tx_ref;
    if (!eventReference || !txRef) {
      throw new BadRequestException('Malformed webhook payload.');
    }

    let heldTransactionId: string | undefined;
    let autoReleaseAt: Date | undefined;

    await this.drizzle.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(chapaWebhookEvents)
        .values({ chapaReference: eventReference, eventType: payload.event ?? 'unknown' })
        .onConflictDoNothing({ target: chapaWebhookEvents.chapaReference })
        .returning();
      if (inserted.length === 0) {
        // Already processed this exact event — idempotent no-op.
        return;
      }

      if (payload.status !== 'success') {
        return;
      }

      const [escrowTransaction] = await tx
        .select()
        .from(escrowTransactions)
        .where(eq(escrowTransactions.chapaTxRef, txRef))
        .for('update')
        .limit(1);
      if (!escrowTransaction) {
        throw new NotFoundException('No escrow transaction matches this webhook tx_ref.');
      }
      if (escrowTransaction.status !== 'pending_payment') {
        // A second, differently-referenced event for an already-handled
        // transaction — idempotent no-op rather than a re-transition.
        return;
      }

      if (
        payload.amount === undefined ||
        parseEtbToSantim(payload.amount) !== escrowTransaction.amountSantim
      ) {
        // Never trust the payload's amount (docs/CODE_GUIDELINES.md §3) —
        // fail loudly rather than silently holding the wrong amount.
        throw new BadRequestException('Webhook amount does not match the recorded transaction.');
      }

      const heldAt = new Date();
      const autoReleaseHours = this.config.get('escrow', { infer: true }).autoReleaseHours;
      autoReleaseAt = new Date(heldAt.getTime() + autoReleaseHours * 60 * 60 * 1000);
      await tx
        .update(escrowTransactions)
        .set({ status: 'held', heldAt, autoReleaseAt })
        .where(eq(escrowTransactions.id, escrowTransaction.id));
      heldTransactionId = escrowTransaction.id;
    });

    // Enqueued after the transaction commits, so a crash mid-handler never
    // leaves a scheduled release for a transaction that isn't actually held.
    if (heldTransactionId && autoReleaseAt) {
      await this.autoReleaseQueue.add(
        'auto-release',
        { escrowTransactionId: heldTransactionId },
        { jobId: heldTransactionId, delay: autoReleaseAt.getTime() - Date.now() },
      );
    }
  }

  /** Buyer-only. Ownership check baked into the WHERE. */
  async confirmReceipt(escrowTransactionId: string, buyerId: string): Promise<EscrowTransaction> {
    const released = await this.drizzle.db.transaction(async (tx) => {
      const transaction = await this.lockOwnedHeldTransaction(tx, escrowTransactionId, buyerId);
      return this.releaseFunds(tx, transaction);
    });
    await this.autoReleaseQueue.remove(released.id);
    return released;
  }

  /** Buyer-only. Ownership check baked into the WHERE. */
  async raiseDispute(
    escrowTransactionId: string,
    buyerId: string,
    dto: RaiseDisputeDto,
  ): Promise<EscrowTransaction> {
    const updated = await this.drizzle.db.transaction(async (tx) => {
      const transaction = await this.lockOwnedHeldTransaction(tx, escrowTransactionId, buyerId);

      const [row] = await tx
        .update(escrowTransactions)
        .set({ status: 'disputed' })
        .where(eq(escrowTransactions.id, transaction.id))
        .returning();
      if (!row) {
        throw new Error('Failed to raise dispute.');
      }
      await tx.insert(disputes).values({
        escrowTransactionId: transaction.id,
        raisedBy: buyerId,
        reason: dto.reason,
      });
      return row;
    });
    await this.autoReleaseQueue.remove(updated.id);
    return updated;
  }

  /**
   * Admin-only (enforced by AdminGuard at the controller). No buyer/seller
   * ownership check. Takes a caller-supplied `tx` rather than opening its
   * own — AdminService runs the dispute-row update and the AuditLog write
   * in the SAME transaction as this release, which docs/ARCHITECTURE.md's
   * AuditLog note treats as non-negotiable, not a nice-to-have.
   */
  async releaseFundsForDispute(tx: Tx, escrowTransactionId: string): Promise<EscrowTransaction> {
    const transaction = await this.lockDisputedTransaction(tx, escrowTransactionId);
    return this.releaseFunds(tx, transaction);
  }

  /** Same caller-supplied-`tx` contract as releaseFundsForDispute above. */
  async refundForDispute(
    tx: Tx,
    escrowTransactionId: string,
    reason: string,
  ): Promise<EscrowTransaction> {
    const transaction = await this.lockDisputedTransaction(tx, escrowTransactionId);

    const refund = await this.chapa.refund({ chapaTxRef: transaction.chapaTxRef, reason });

    const [updated] = await tx
      .update(escrowTransactions)
      .set({ status: 'refunded', chapaRefundRef: refund.refundRef })
      .where(eq(escrowTransactions.id, transaction.id))
      .returning();
    if (!updated) {
      throw new Error('Failed to refund escrow transaction.');
    }
    return updated;
  }

  /** Called by AutoReleaseProcessor when the delayed job fires. No-op if already resolved manually. */
  async autoRelease(escrowTransactionId: string): Promise<void> {
    await this.drizzle.db.transaction(async (tx) => {
      const [transaction] = await tx
        .select()
        .from(escrowTransactions)
        .where(eq(escrowTransactions.id, escrowTransactionId))
        .for('update')
        .limit(1);
      if (!transaction || transaction.status !== 'held') {
        // Already confirmed/disputed manually, or the row doesn't exist
        // (shouldn't happen) — re-verifying after the lock, same
        // discipline as every other transition here.
        return;
      }
      await this.releaseFunds(tx, transaction);
    });
  }

  /**
   * The one place amountSantim is split and paid out. Computes the fee
   * fresh at release time (not snapshotted at initiation), calls Chapa's
   * Transfer API while still holding the row lock so a concurrent
   * confirm-receipt/dispute/auto-release on the same transaction cannot
   * also release — same "lock, re-verify, then act, all in one
   * transaction" discipline as BarterService.accept.
   */
  private async releaseFunds(tx: Tx, transaction: EscrowTransaction): Promise<EscrowTransaction> {
    const [seller] = await tx
      .select({
        payoutBankCode: users.payoutBankCode,
        payoutAccountNumber: users.payoutAccountNumber,
        payoutAccountName: users.payoutAccountName,
        verificationLevel: users.verificationLevel,
      })
      .from(users)
      .where(eq(users.id, transaction.sellerId))
      .limit(1);
    if (!seller?.payoutBankCode || !seller.payoutAccountNumber || !seller.payoutAccountName) {
      throw new BadRequestException(
        'Seller has not set up a payout account yet (PATCH /users/me/payout-account).',
      );
    }

    // The business-tier discount is
    // checked fresh at release time, same as the fee itself, so a seller
    // approved for `business` verification after initiation still gets
    // the lower rate on release.
    const feeBps =
      seller.verificationLevel === 'business'
        ? ESCROW_PLATFORM_FEE_BPS_BUSINESS
        : ESCROW_PLATFORM_FEE_BPS;
    const platformFeeSantim = (transaction.amountSantim * feeBps) / 10_000n;
    const sellerSantim = transaction.amountSantim - platformFeeSantim;

    const transfer = await this.chapa.createTransfer({
      amountSantim: sellerSantim,
      bankCode: seller.payoutBankCode,
      accountNumber: seller.payoutAccountNumber,
      accountName: seller.payoutAccountName,
      reference: `escrow_release_${transaction.id}`,
    });

    const [updated] = await tx
      .update(escrowTransactions)
      .set({
        status: 'released',
        platformFeeSantim,
        chapaTransferRef: transfer.transferRef,
        releasedAt: new Date(),
      })
      .where(eq(escrowTransactions.id, transaction.id))
      .returning();
    if (!updated) {
      throw new Error('Failed to release escrow transaction.');
    }
    return updated;
  }

  /**
   * Shared by confirmReceipt/raiseDispute — locks the transaction scoped
   * to the calling buyer (ownership baked into the WHERE, per
   * docs/CODE_GUIDELINES.md §5), then re-verifies `held` after the lock.
   */
  private async lockOwnedHeldTransaction(
    tx: Tx,
    escrowTransactionId: string,
    buyerId: string,
  ): Promise<EscrowTransaction> {
    const [transaction] = await tx
      .select()
      .from(escrowTransactions)
      .where(
        and(
          eq(escrowTransactions.id, escrowTransactionId),
          eq(escrowTransactions.buyerId, buyerId),
        ),
      )
      .for('update')
      .limit(1);
    if (!transaction) {
      throw new NotFoundException('Escrow transaction not found.');
    }
    if (transaction.status !== 'held') {
      throw new ConflictException('This escrow transaction is not currently held.');
    }
    return transaction;
  }

  private async lockDisputedTransaction(
    tx: Tx,
    escrowTransactionId: string,
  ): Promise<EscrowTransaction> {
    const [transaction] = await tx
      .select()
      .from(escrowTransactions)
      .where(eq(escrowTransactions.id, escrowTransactionId))
      .for('update')
      .limit(1);
    if (!transaction) {
      throw new NotFoundException('Escrow transaction not found.');
    }
    if (transaction.status !== 'disputed') {
      throw new ConflictException('This escrow transaction is not currently disputed.');
    }
    return transaction;
  }
}
