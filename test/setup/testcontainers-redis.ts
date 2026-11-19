import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export interface StartedRedis {
  connectionUrl: string;
  stop: () => Promise<void>;
}

/**
 * A dedicated Redis container per test suite. Without this, e2e specs fall
 * back to the host's shared REDIS_URL, and once more than one e2e spec
 * file exists, two Nest app instances end up running two BullMQ workers
 * against the *same* queue on that one Redis — each can consume the
 * other's OTP delivery job, so FakeSmsService.waitForCodeAfter times out
 * nondeterministically depending on which worker won the race. A real,
 * isolated Redis per suite (mirroring testcontainers-postgres.ts) removes
 * the shared state instead of trying to synchronize around it.
 */
export async function startRedis(): Promise<StartedRedis> {
  const container: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const connectionUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;

  return {
    connectionUrl,
    stop: async () => {
      await container.stop();
    },
  };
}
