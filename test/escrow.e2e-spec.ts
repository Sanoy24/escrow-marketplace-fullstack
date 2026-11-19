import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CHAPA_SERVICE } from '../src/chapa/chapa.interface';
import { formatSantimToEtb } from '../src/common/money/parse-etb';
import { SMS_SERVICE } from '../src/sms/sms.interface';
import { FakeChapaService } from './setup/fake-chapa.service';
import { FakeSmsService } from './setup/fake-sms.service';
import { startPostgres, type StartedPostgres } from './setup/testcontainers-postgres';
import { startRedis, type StartedRedis } from './setup/testcontainers-redis';

const PHONE = (suffix: number): string => `+2519${String(suffix).padStart(8, '0')}`;
const BFF_PROXY_SECRET = 'test-bff-proxy-secret-at-least-32-characters';
const TEST_PASSWORD = 'Test-password-123';
// ~2 seconds — long enough that every other test's synchronous
// webhook -> confirm-receipt/dispute sequence finishes well before this
// elapses (so the auto-release job never interferes with a manual
// resolution), short enough that the dedicated auto-release test doesn't
// need a real multi-day wait.
const AUTO_RELEASE_TEST_HOURS = '0.0005555555555555556';

interface TestUser {
  userId: string;
  accessToken: string;
  forwardedFor: string;
}

describe('Escrow (e2e)', () => {
  let pg: StartedPostgres;
  let redis: StartedRedis;
  let rawPool: Pool;
  let app: INestApplication;
  let sms: FakeSmsService;
  let chapa: FakeChapaService;
  let categoryId: string;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
    rawPool = new Pool({ connectionString: pg.connectionUri });

    process.env.DATABASE_URL = pg.connectionUri;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-characters-long';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long';
    process.env.BFF_PROXY_SECRET = BFF_PROXY_SECRET;
    process.env.ESCROW_AUTO_RELEASE_HOURS = AUTO_RELEASE_TEST_HOURS;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_SERVICE)
      .useClass(FakeSmsService)
      .overrideProvider(CHAPA_SERVICE)
      .useClass(FakeChapaService)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    sms = moduleRef.get(SMS_SERVICE);
    chapa = moduleRef.get(CHAPA_SERVICE);

    categoryId = randomUUID();
    await rawPool.query('insert into categories (id, name, slug) values ($1, $2, $3)', [
      categoryId,
      'Electronics',
      'electronics',
    ]);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await rawPool.end();
    await pg.stop();
    await redis.stop();
  });

  function authed(user: TestUser, req: request.Test): request.Test {
    return req
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('X-Forwarded-For', user.forwardedFor)
      .set('X-BFF-Proxy-Secret', BFF_PROXY_SECRET);
  }

  async function verifiedUser(suffix: number): Promise<TestUser> {
    const phone = PHONE(suffix);
    const forwardedFor = `10.0.6.${suffix}`;
    const smsCountBefore = sms.sent.length;
    await request(app.getHttpServer())
      .post('/auth/signup')
      .set('X-Forwarded-For', forwardedFor)
      .set('X-BFF-Proxy-Secret', BFF_PROXY_SECRET)
      .send({ phone, password: TEST_PASSWORD })
      .expect(200);
    const code = await sms.waitForCodeAfter(smsCountBefore);
    const verifyRes = await request(app.getHttpServer())
      .post('/auth/signup/verify')
      .set('X-Forwarded-For', forwardedFor)
      .set('X-BFF-Proxy-Secret', BFF_PROXY_SECRET)
      .send({ phone, code })
      .expect(201);
    const body = verifyRes.body as { user: { id: string }; accessToken: string };
    return { userId: body.user.id, accessToken: body.accessToken, forwardedFor };
  }

  async function idVerifiedSeller(suffix: number): Promise<TestUser> {
    const seller = await verifiedUser(suffix);
    await rawPool.query("update users set verification_level = 'id' where id = $1", [
      seller.userId,
    ]);
    return seller;
  }

  async function businessVerifiedSeller(suffix: number): Promise<TestUser> {
    const seller = await verifiedUser(suffix);
    await rawPool.query("update users set verification_level = 'business' where id = $1", [
      seller.userId,
    ]);
    return seller;
  }

  async function withPayoutAccount(seller: TestUser): Promise<TestUser> {
    await authed(seller, request(app.getHttpServer()).patch('/users/me/payout-account'))
      .send({ bankCode: '130', accountNumber: '1000012345678', accountName: 'Test Seller' })
      .expect(200);
    return seller;
  }

  async function makeAdmin(user: TestUser): Promise<TestUser> {
    await rawPool.query("update users set role = 'admin' where id = $1", [user.userId]);
    return user;
  }

  async function createListing(seller: TestUser, title: string, price: string): Promise<string> {
    const res = await authed(seller, request(app.getHttpServer()).post('/listings'))
      .send({ categoryId, title, price, condition: 'used', locationCity: 'Addis Ababa' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createOrder(buyer: TestUser, listingIds: string[]): Promise<string> {
    const res = await authed(buyer, request(app.getHttpServer()).post('/orders'))
      .send({ listingIds })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  interface InitiatedEscrow {
    escrowTransactionId: string;
    chapaTxRef: string;
    amountSantim: string;
  }

  async function initiateEscrow(buyer: TestUser, orderId: string): Promise<InitiatedEscrow> {
    const res = await authed(buyer, request(app.getHttpServer()).post('/escrow'))
      .send({ orderId })
      .expect(201);
    const body = res.body as {
      escrowTransaction: { id: string; chapaTxRef: string; amountSantim: string };
    };
    return {
      escrowTransactionId: body.escrowTransaction.id,
      chapaTxRef: body.escrowTransaction.chapaTxRef,
      amountSantim: body.escrowTransaction.amountSantim,
    };
  }

  function sendWebhook(
    txRef: string,
    amountSantim: string,
    overrides: Partial<{ status: string; reference: string; amount: string }> = {},
  ): request.Test {
    const payload = {
      event: 'charge.success',
      tx_ref: txRef,
      reference: overrides.reference ?? randomUUID(),
      status: overrides.status ?? 'success',
      amount: overrides.amount ?? formatSantimToEtb(BigInt(amountSantim)),
    };
    return request(app.getHttpServer())
      .post('/escrow/webhook')
      .set('Content-Type', 'application/json')
      .send(payload);
  }

  async function escrowStatus(escrowTransactionId: string): Promise<string> {
    const { rows } = await rawPool.query('select status from escrow_transactions where id = $1', [
      escrowTransactionId,
    ]);
    return rows[0]?.status;
  }

  async function waitUntilStatus(
    escrowTransactionId: string,
    status: string,
    timeoutMs = 8000,
  ): Promise<void> {
    const start = Date.now();
    while ((await escrowStatus(escrowTransactionId)) !== status) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for escrow transaction ${escrowTransactionId} to reach ${status}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('runs a full happy-path cycle: initiate -> webhook -> held -> confirm-receipt -> released', async () => {
    const buyer = await verifiedUser(1);
    const seller = await withPayoutAccount(await idVerifiedSeller(2));
    const listingId = await createListing(seller, 'Phone', '5000');
    const orderId = await createOrder(buyer, [listingId]);

    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);
    expect(await escrowStatus(escrowTransactionId)).toBe('pending_payment');

    await sendWebhook(chapaTxRef, amountSantim).expect(200);
    expect(await escrowStatus(escrowTransactionId)).toBe('held');

    const transfersBefore = chapa.transfers.length;
    const confirmRes = await authed(
      buyer,
      request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/confirm-receipt`),
    ).expect(201);
    const body = confirmRes.body as {
      status: string;
      platformFeeSantim: string;
      chapaTransferRef: string;
    };
    expect(body.status).toBe('released');
    expect(body.chapaTransferRef).toBeTruthy();

    const platformFeeSantim = BigInt(body.platformFeeSantim);
    const expectedFee = (BigInt(amountSantim) * 300n) / 10_000n;
    expect(platformFeeSantim).toBe(expectedFee);
    const sellerSantim = BigInt(amountSantim) - platformFeeSantim;
    expect(platformFeeSantim + sellerSantim).toBe(BigInt(amountSantim));

    expect(chapa.transfers).toHaveLength(transfersBefore + 1);
    expect(chapa.transfers.at(-1)?.amountSantim).toBe(sellerSantim);
  });

  it('charges the reduced 2% platform fee for a business-verified seller on release', async () => {
    const buyer = await verifiedUser(30);
    const seller = await withPayoutAccount(await businessVerifiedSeller(31));
    const listingId = await createListing(seller, 'Dealer phone', '5000');
    const orderId = await createOrder(buyer, [listingId]);

    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);
    await sendWebhook(chapaTxRef, amountSantim).expect(200);

    const confirmRes = await authed(
      buyer,
      request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/confirm-receipt`),
    ).expect(201);
    const body = confirmRes.body as { platformFeeSantim: string };

    const platformFeeSantim = BigInt(body.platformFeeSantim);
    const expectedFee = (BigInt(amountSantim) * 200n) / 10_000n;
    expect(platformFeeSantim).toBe(expectedFee);
  });

  it('rejects initiating escrow against an unverified seller', async () => {
    const buyer = await verifiedUser(3);
    const seller = await verifiedUser(4); // no ID verification
    const listingId = await createListing(seller, 'Unverified seller item', '1000');
    const orderId = await createOrder(buyer, [listingId]);

    await authed(buyer, request(app.getHttpServer()).post('/escrow')).send({ orderId }).expect(403);
  });

  it('rejects the seller initiating escrow on their own sale', async () => {
    const buyer = await verifiedUser(5);
    const seller = await idVerifiedSeller(6);
    const listingId = await createListing(seller, 'Seller cannot self-initiate', '1000');
    const orderId = await createOrder(buyer, [listingId]);

    // The seller IS a participant on the order (so getForParticipant finds
    // it), but EscrowService's explicit buyer-only check still rejects it.
    await authed(seller, request(app.getHttpServer()).post('/escrow'))
      .send({ orderId })
      .expect(400);
  });

  it('rejects a webhook whose amount does not match the recorded transaction', async () => {
    const buyer = await verifiedUser(7);
    const seller = await withPayoutAccount(await idVerifiedSeller(8));
    const listingId = await createListing(seller, 'Amount mismatch item', '5000');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef } = await initiateEscrow(buyer, orderId);

    await sendWebhook(chapaTxRef, '1', { amount: '1.00' }).expect(400);
    expect(await escrowStatus(escrowTransactionId)).toBe('pending_payment');
  });

  it('is idempotent for a replayed webhook event (same reference twice)', async () => {
    const buyer = await verifiedUser(9);
    const seller = await withPayoutAccount(await idVerifiedSeller(10));
    const listingId = await createListing(seller, 'Idempotent webhook item', '2000');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);

    const reference = randomUUID();
    await sendWebhook(chapaTxRef, amountSantim, { reference }).expect(200);
    expect(await escrowStatus(escrowTransactionId)).toBe('held');
    const { rows: heldOnce } = await rawPool.query(
      'select held_at from escrow_transactions where id = $1',
      [escrowTransactionId],
    );

    // Exact same event replayed — the unique constraint on
    // chapa_reference makes this a no-op, not a re-transition.
    await sendWebhook(chapaTxRef, amountSantim, { reference }).expect(200);
    const { rows: heldTwice } = await rawPool.query(
      'select held_at from escrow_transactions where id = $1',
      [escrowTransactionId],
    );
    expect(heldTwice[0]?.held_at).toEqual(heldOnce[0]?.held_at);

    const { rows: eventRows } = await rawPool.query(
      'select count(*)::int as count from chapa_webhook_events where chapa_reference = $1',
      [reference],
    );
    expect(eventRows[0].count).toBe(1);
  });

  it('handles two concurrent confirm-receipt calls on the same held transaction: exactly one wins', async () => {
    const buyer = await verifiedUser(11);
    const seller = await withPayoutAccount(await idVerifiedSeller(12));
    const listingId = await createListing(seller, 'Race item', '4000');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);
    await sendWebhook(chapaTxRef, amountSantim).expect(200);

    const transfersBefore = chapa.transfers.length;
    const [resOne, resTwo] = await Promise.all([
      authed(
        buyer,
        request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/confirm-receipt`),
      ),
      authed(
        buyer,
        request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/confirm-receipt`),
      ),
    ]);

    const statuses = [resOne.status, resTwo.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect(chapa.transfers).toHaveLength(transfersBefore + 1);
    expect(await escrowStatus(escrowTransactionId)).toBe('released');
  });

  it('confirm-receipt 404s for a non-buyer', async () => {
    const buyer = await verifiedUser(13);
    const seller = await withPayoutAccount(await idVerifiedSeller(14));
    const stranger = await verifiedUser(15);
    const listingId = await createListing(seller, 'Non-buyer item', '3000');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);
    await sendWebhook(chapaTxRef, amountSantim).expect(200);

    await authed(
      seller,
      request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/confirm-receipt`),
    ).expect(404);
    await authed(
      stranger,
      request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/confirm-receipt`),
    ).expect(404);
  });

  it('confirm-receipt fails clearly when the seller has no payout account on file', async () => {
    const buyer = await verifiedUser(16);
    const seller = await idVerifiedSeller(17); // no withPayoutAccount
    const listingId = await createListing(seller, 'No payout account item', '3000');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);
    await sendWebhook(chapaTxRef, amountSantim).expect(200);

    await authed(
      buyer,
      request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/confirm-receipt`),
    ).expect(400);
    expect(await escrowStatus(escrowTransactionId)).toBe('held');
  });

  it("resolves a dispute in the seller's favor: releases funds and writes an audit log", async () => {
    const buyer = await verifiedUser(18);
    const seller = await withPayoutAccount(await idVerifiedSeller(19));
    const admin = await makeAdmin(await verifiedUser(20));
    const listingId = await createListing(seller, 'Dispute seller-favor item', '6000');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);
    await sendWebhook(chapaTxRef, amountSantim).expect(200);

    await authed(buyer, request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/dispute`))
      .send({ reason: 'Item never arrived, or so the buyer initially claims.' })
      .expect(201);
    expect(await escrowStatus(escrowTransactionId)).toBe('disputed');

    const listRes = await authed(admin, request(app.getHttpServer()).get('/admin/disputes')).expect(
      200,
    );
    const disputeRow = (
      listRes.body as { dispute: { id: string }; escrowTransaction: { id: string } }[]
    ).find((row) => row.escrowTransaction.id === escrowTransactionId);
    expect(disputeRow).toBeDefined();

    const transfersBefore = chapa.transfers.length;
    const resolveRes = await authed(
      admin,
      request(app.getHttpServer()).post(`/admin/disputes/${disputeRow?.dispute.id}/resolve`),
    )
      .send({ resolution: 'seller', note: 'Delivery confirmed via chat history.' })
      .expect(201);
    const body = resolveRes.body as { escrowTransaction: { status: string } };
    expect(body.escrowTransaction.status).toBe('released');
    expect(chapa.transfers).toHaveLength(transfersBefore + 1);

    const { rows: auditRows } = await rawPool.query(
      "select action, target_type, target_id from audit_logs where target_id = $1 and action = 'dispute_resolved'",
      [disputeRow?.dispute.id],
    );
    expect(auditRows).toHaveLength(1);
  });

  it("resolves a dispute in the buyer's favor: refunds and writes an audit log", async () => {
    const buyer = await verifiedUser(21);
    const seller = await withPayoutAccount(await idVerifiedSeller(22));
    const admin = await makeAdmin(await verifiedUser(23));
    const listingId = await createListing(seller, 'Dispute buyer-favor item', '7000');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);
    await sendWebhook(chapaTxRef, amountSantim).expect(200);

    await authed(buyer, request(app.getHttpServer()).post(`/escrow/${escrowTransactionId}/dispute`))
      .send({ reason: 'Item was materially different from the listing.' })
      .expect(201);

    const listRes = await authed(admin, request(app.getHttpServer()).get('/admin/disputes')).expect(
      200,
    );
    const disputeRow = (
      listRes.body as { dispute: { id: string }; escrowTransaction: { id: string } }[]
    ).find((row) => row.escrowTransaction.id === escrowTransactionId);

    const refundsBefore = chapa.refunds.length;
    const resolveRes = await authed(
      admin,
      request(app.getHttpServer()).post(`/admin/disputes/${disputeRow?.dispute.id}/resolve`),
    )
      .send({ resolution: 'buyer' })
      .expect(201);
    const body = resolveRes.body as { escrowTransaction: { status: string } };
    expect(body.escrowTransaction.status).toBe('refunded');
    expect(chapa.refunds).toHaveLength(refundsBefore + 1);
  });

  it('rejects a non-admin from listing or resolving disputes', async () => {
    const nonAdmin = await verifiedUser(24);

    await authed(nonAdmin, request(app.getHttpServer()).get('/admin/disputes')).expect(403);
    await authed(
      nonAdmin,
      request(app.getHttpServer()).post(`/admin/disputes/${randomUUID()}/resolve`),
    )
      .send({ resolution: 'seller' })
      .expect(403);
  });

  it('auto-releases a held transaction with no dispute once the window elapses', async () => {
    const buyer = await verifiedUser(25);
    const seller = await withPayoutAccount(await idVerifiedSeller(26));
    const listingId = await createListing(seller, 'Auto-release item', '2500');
    const orderId = await createOrder(buyer, [listingId]);
    const { escrowTransactionId, chapaTxRef, amountSantim } = await initiateEscrow(buyer, orderId);

    const transfersBefore = chapa.transfers.length;
    await sendWebhook(chapaTxRef, amountSantim).expect(200);
    expect(await escrowStatus(escrowTransactionId)).toBe('held');

    // Nobody confirms receipt or disputes — the auto-release job (queued
    // by the webhook handler for ~2s out, see AUTO_RELEASE_TEST_HOURS)
    // must fire on its own.
    await waitUntilStatus(escrowTransactionId, 'released');
    expect(chapa.transfers).toHaveLength(transfersBefore + 1);
  });
});
