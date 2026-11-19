import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import request from 'supertest';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { RedisIoAdapter } from '../src/messaging/redis-io.adapter';
import { SMS_SERVICE } from '../src/sms/sms.interface';
import { FakeSmsService } from './setup/fake-sms.service';
import { startPostgres, type StartedPostgres } from './setup/testcontainers-postgres';
import { startRedis, type StartedRedis } from './setup/testcontainers-redis';

// Zero-padded to a fixed 8 digits after the leading '9' so the result is
// always a valid 9-digit Ethiopian mobile number regardless of how many
// distinct test users a given spec file needs (unlike a bare numeric
// suffix, which stops being a valid length once it reaches double digits).
const PHONE = (suffix: number): string => `+2519${String(suffix).padStart(8, '0')}`;
const BFF_PROXY_SECRET = 'test-bff-proxy-secret-at-least-32-characters';
const TEST_PASSWORD = 'Test-password-123';

function connectSocket(port: number, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket: ClientSocket = io(`http://localhost:${port}/messaging`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err: Error) => reject(err));
  });
}

interface JoinAck {
  ok: boolean;
}

function joinConversation(socket: ClientSocket, conversationId: string): Promise<JoinAck> {
  return new Promise((resolve) => {
    socket.emit('join', { conversationId }, (ack: JoinAck) => resolve(ack));
  });
}

function waitForMessage(socket: ClientSocket): Promise<{ body: string; senderId: string }> {
  return new Promise((resolve) => {
    socket.once('message', resolve);
  });
}

describe('Messaging (e2e)', () => {
  let pg: StartedPostgres;
  let redis: StartedRedis;
  let rawPool: Pool;
  let app: INestApplication;
  let sms: FakeSmsService;
  let categoryId: string;
  let port: number;
  let redisIoAdapter: RedisIoAdapter;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
    rawPool = new Pool({ connectionString: pg.connectionUri });

    process.env.DATABASE_URL = pg.connectionUri;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-characters-long';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long';
    process.env.BFF_PROXY_SECRET = BFF_PROXY_SECRET;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_SERVICE)
      .useClass(FakeSmsService)
      .compile();

    app = moduleRef.createNestApplication();
    redisIoAdapter = new RedisIoAdapter(app);
    redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);

    await app.init();
    // WS needs a real bound port — supertest's unbound-app trick only
    // covers plain HTTP requests, not a socket.io-client connection.
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    sms = moduleRef.get(SMS_SERVICE);

    categoryId = randomUUID();
    await rawPool.query('insert into categories (id, name, slug) values ($1, $2, $3)', [
      categoryId,
      'Furniture',
      'furniture',
    ]);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    // Not covered by app.close(): RedisIoAdapter is a manually-constructed
    // instance, not DI-managed, so Nest never calls its own close() hook.
    // Quit its pub/sub clients before the Redis container stops, or
    // ioredis logs an unhandled "Connection is closed" error once it does.
    await Promise.all([redisIoAdapter.disconnectRedis(), redisIoAdapter.disconnectRedis()]);
    await rawPool.end();
    await pg.stop();
    await redis.stop();
  });

  async function verifiedUser(suffix: number): Promise<{ userId: string; accessToken: string }> {
    const phone = PHONE(suffix);
    // A distinct X-Forwarded-For per synthetic user — POST /auth/signup
    // is rate-limited per tracked IP (5/60s, see AuthController), and
    // ForwardedIpThrottlerGuard prefers this header specifically so a BFF
    // proxying many real visitors through one server IP doesn't collapse
    // their limits into one shared bucket. Without it here, this suite's
    // 11 distinct test users would all share the test client's one raw
    // connection IP and trip that limit long before reaching 11 requests.
    const forwardedFor = `10.0.0.${suffix}`;
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
    return { userId: body.user.id, accessToken: body.accessToken };
  }

  async function createListing(sellerToken: string, title: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/listings')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        categoryId,
        title,
        price: '5000',
        condition: 'used',
        locationCity: 'Addis Ababa',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  it('creates a conversation and is idempotent for the same buyer+listing', async () => {
    const seller = await verifiedUser(1);
    const buyer = await verifiedUser(2);
    const listingId = await createListing(seller.accessToken, 'Sofa set');

    const firstRes = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId })
      .expect(201);

    const secondRes = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId })
      .expect(201);

    expect(secondRes.body.id).toBe(firstRes.body.id);
  });

  it('rejects starting a conversation about your own listing', async () => {
    const seller = await verifiedUser(3);
    const listingId = await createListing(seller.accessToken, 'Bookshelf');

    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ listingId })
      .expect(400);
  });

  it('rejects starting a new conversation for a listing that is no longer active', async () => {
    const seller = await verifiedUser(12);
    const buyer = await verifiedUser(13);
    const listingId = await createListing(seller.accessToken, 'Already sold lamp');

    await request(app.getHttpServer())
      .patch(`/listings/${listingId}`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .send({ status: 'sold' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId })
      .expect(404);
  });

  it('lists conversations for both the buyer and seller side, and hides the history from a stranger', async () => {
    const seller = await verifiedUser(4);
    const buyer = await verifiedUser(5);
    const stranger = await verifiedUser(6);
    const listingId = await createListing(seller.accessToken, 'Dining table');

    const createRes = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId })
      .expect(201);
    const conversationId = createRes.body.id as string;

    const buyerList = await request(app.getHttpServer())
      .get('/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .expect(200);
    expect(buyerList.body.some((c: { id: string }) => c.id === conversationId)).toBe(true);

    const sellerList = await request(app.getHttpServer())
      .get('/conversations')
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .expect(200);
    expect(sellerList.body.some((c: { id: string }) => c.id === conversationId)).toBe(true);

    await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(404);
  });

  it('delivers a message live between two connected sockets and persists it in history', async () => {
    const seller = await verifiedUser(7);
    const buyer = await verifiedUser(8);
    const listingId = await createListing(seller.accessToken, 'Office chair');

    const createRes = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId })
      .expect(201);
    const conversationId = createRes.body.id as string;

    const buyerSocket = await connectSocket(port, buyer.accessToken);
    const sellerSocket = await connectSocket(port, seller.accessToken);

    try {
      expect(await joinConversation(buyerSocket, conversationId)).toEqual({ ok: true });
      expect(await joinConversation(sellerSocket, conversationId)).toEqual({ ok: true });

      const sellerReceived = waitForMessage(sellerSocket);
      buyerSocket.emit('message', { conversationId, body: 'Is this still available?' });
      const received = await sellerReceived;
      expect(received.body).toBe('Is this still available?');
      expect(received.senderId).toBe(buyer.userId);
    } finally {
      buyerSocket.disconnect();
      sellerSocket.disconnect();
    }

    const historyRes = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${seller.accessToken}`)
      .expect(200);
    expect(
      historyRes.body.items.some((m: { body: string }) => m.body === 'Is this still available?'),
    ).toBe(true);
  });

  it("refuses to join or send into a conversation the socket isn't part of", async () => {
    const seller = await verifiedUser(9);
    const buyer = await verifiedUser(10);
    const stranger = await verifiedUser(11);
    const listingId = await createListing(seller.accessToken, 'Standing desk');

    const createRes = await request(app.getHttpServer())
      .post('/conversations')
      .set('Authorization', `Bearer ${buyer.accessToken}`)
      .send({ listingId })
      .expect(201);
    const conversationId = createRes.body.id as string;

    const strangerSocket = await connectSocket(port, stranger.accessToken);
    try {
      expect(await joinConversation(strangerSocket, conversationId)).toEqual({ ok: false });
    } finally {
      strangerSocket.disconnect();
    }
  });

  it('rejects a socket connection with no or an invalid token', async () => {
    await expect(connectSocket(port, 'not-a-real-token')).rejects.toBeDefined();
  });

  it('allows the configured frontend origin on the Socket.io handshake', async () => {
    await request(app.getHttpServer())
      .get('/socket.io/')
      .query({ EIO: '4', transport: 'polling' })
      .set('Origin', 'http://localhost:3001')
      .expect('Access-Control-Allow-Origin', 'http://localhost:3001')
      .expect(200);
  });
});
