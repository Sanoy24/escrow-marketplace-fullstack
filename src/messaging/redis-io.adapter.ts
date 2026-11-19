import { type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import type { AppConfig } from '../config/configuration';

/**
 * Wires the Socket.io Redis adapter from day one, per docs/ARCHITECTURE.md
 * §2 — without it, two users connected to different backend instances
 * silently can't reach each other over WS once this runs as more than one
 * instance. A dev single-instance setup would never surface that gap, so
 * it's not something to defer "until it's needed".
 */
export class RedisIoAdapter extends IoAdapter {
  private pubClient?: Redis;
  private subClient?: Redis;
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private frontendOrigin?: string;
  private disconnectPromise?: Promise<void>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  connectToRedis(): void {
    const configService = this.app.get<ConfigService, ConfigService<AppConfig, true>>(
      ConfigService,
    );
    const redisUrl = configService.get('redisUrl', { infer: true });
    this.frontendOrigin = configService.get('frontendOrigin', { infer: true });

    this.pubClient = new Redis(redisUrl);
    this.subClient = this.pubClient.duplicate();
    // A raw ioredis client with zero 'error' listeners turns an expected
    // "connection closed" during teardown into an uncaught exception that
    // crashes the whole process — unlike BullMQ's own Redis connections
    // elsewhere in this app, which attach their own handler internally.
    // Deliberately silent, not logged: quitting these right before a
    // test's Redis testcontainer stops (or a real process shutting down)
    // routinely races an ECONNRESET on the socket's actual close a tick
    // after `.quit()` already resolved — expected teardown noise, not an
    // actionable error, and logging it async after Jest's environment has
    // torn down turns a harmless race into a failed test suite.
    const noop = (): void => {};
    this.pubClient.on('error', noop);
    this.subClient.on('error', noop);
    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
  }

  createIOServer(port: number, options?: Record<string, unknown>): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.frontendOrigin,
        credentials: true,
      },
    }) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  async close(server: Server): Promise<void> {
    await super.close(server);
    await this.disconnectRedis();
  }

  /**
   * Exposed separately from `close(server)` — Nest's `app.close()` doesn't
   * reliably call a manually-constructed adapter's `close()` (this adapter
   * isn't DI-managed), so callers that create their own RedisIoAdapter
   * (main.ts, and e2e test setup) must quit these clients explicitly
   * before tearing down the Redis they're connected to, or ioredis logs
   * an unhandled "Connection is closed" error once the container/process
   * disappears out from under an still-open client.
   */
  async disconnectRedis(): Promise<void> {
    // .catch() here, not just the 'error' listener above: if the
    // underlying socket is torn down (e.g. a test's container stopping)
    // while a QUIT command is still in flight, ioredis rejects that
    // command's own promise — a separate mechanism from the 'error'
    // event, and one an `await` without a catch would still propagate.
    if (this.disconnectPromise) return this.disconnectPromise;

    const clients = [this.pubClient, this.subClient].filter(
      (client): client is Redis => client !== undefined,
    );
    // Clear the fields before awaiting so overlapping shutdown hooks cannot
    // issue QUIT twice against the same connection.
    this.pubClient = undefined;
    this.subClient = undefined;
    this.adapterConstructor = undefined;
    this.disconnectPromise = Promise.all(
      clients.map(async (client) => {
        if (client.status === 'end') return;
        await client.quit().catch(() => client.disconnect(false));
      }),
    ).then(() => undefined);

    return this.disconnectPromise;
  }
}
