import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import path from 'node:path';

export interface StartedPostgres {
  connectionUri: string;
  stop: () => Promise<void>;
}

/**
 * Starts a real Postgres container and runs the committed Drizzle
 * migrations against it — never SQLite, and never a schema built from
 * model definitions. Both of those gaps bit the reference project in
 * production; running the actual migration files here is what makes this
 * test suite trustworthy about what will happen in a real environment.
 * See docs/CODE_GUIDELINES.md §7-8.
 */
export async function startPostgres(): Promise<StartedPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('classifieds_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const connectionUri = container.getConnectionUri();

  execSync('npx drizzle-kit migrate', {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: 'inherit',
  });

  return {
    connectionUri,
    stop: async () => {
      await container.stop();
    },
  };
}
