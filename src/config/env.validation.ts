import { z } from 'zod';

export const LOCAL_BFF_PROXY_SECRET = 'local-bff-proxy-secret-change-before-production';

/**
 * Validated once at boot. A missing/invalid var crashes startup with a named
 * field instead of surfacing as a runtime failure on the first real request
 * (e.g. a missing JWT secret failing silently until someone tries to log in).
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    FRONTEND_ORIGIN: z.url().default('http://localhost:3001'),
    BFF_PROXY_SECRET: z
      .string()
      .min(32, 'BFF_PROXY_SECRET must be at least 32 characters')
      .default(LOCAL_BFF_PROXY_SECRET),
    // Set only in production, to a leading-dot parent domain (e.g.
    // ".yourdomain.com") so the refresh-token cookie (Phase 10 — see
    // docs/ARCHITECTURE.md's BFF-removal section) is valid for both the
    // api. and app. subdomains. Left unset in local dev: a host-only
    // cookie (no Domain attribute) already works fine when frontend and
    // backend are both just "localhost" at different ports.
    COOKIE_DOMAIN: z.string().optional(),

    // HS256 secrets — 32+ chars so a short/blank value can't ship to production
    // and let anyone forge a token.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

    // Chapa sandbox keys (docs/ARCHITECTURE.md §5 -- sandbox/test mode
    // only until legal review clears real-money flows). No .default(): a
    // missing payment secret must crash startup, not fail silently on the
    // first real request (docs/CODE_GUIDELINES.md §6).
    CHAPA_SECRET_KEY: z.string().min(1, 'CHAPA_SECRET_KEY is required'),
    CHAPA_WEBHOOK_SECRET: z.string().min(1, 'CHAPA_WEBHOOK_SECRET is required'),
    // The held -> released auto-release window (docs/ARCHITECTURE.md §5's
    // example is 7 days = 168 hours). Not constrained to an integer so an
    // e2e test can override it to a fraction of a second (e.g. "0.0003")
    // to force the auto-release path without a real multi-day wait.
    ESCROW_AUTO_RELEASE_HOURS: z.coerce.number().positive().default(168),

    // OAuth app credentials (Google Cloud Console / Meta for Developers).
    // Dev placeholders so the app boots and the strategies register without
    // real values — the actual Google/Facebook handshake only works once
    // real credentials are supplied. This backend's own base URL, used to
    // build the absolute .../auth/google/callback etc. redirect URI Passport
    // registers with each provider.
    GOOGLE_CLIENT_ID: z.string().default('dev-google-client-id'),
    GOOGLE_CLIENT_SECRET: z.string().default('dev-google-client-secret'),
    FACEBOOK_CLIENT_ID: z.string().default('dev-facebook-client-id'),
    FACEBOOK_CLIENT_SECRET: z.string().default('dev-facebook-client-secret'),
    OAUTH_CALLBACK_BASE_URL: z.url().default('http://localhost:3000'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.BFF_PROXY_SECRET === LOCAL_BFF_PROXY_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['BFF_PROXY_SECRET'],
        message: 'BFF_PROXY_SECRET must be explicitly set in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
