import { type Env } from './env.validation';

/**
 * Typed accessor shape for ConfigService<AppConfig, true>. Grouped by
 * concern rather than mirroring env var names 1:1, so call sites read
 * `config.jwt.accessTtlSeconds` instead of `config.get('JWT_ACCESS_TTL_SECONDS')`.
 */
export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  databaseUrl: string;
  redisUrl: string;
  frontendOrigin: string;
  bffProxySecret: string;
  cookieDomain: string | undefined;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
  };
  otp: {
    ttlMinutes: number;
    maxAttempts: number;
  };
  oauth: {
    googleClientId: string;
    googleClientSecret: string;
    facebookClientId: string;
    facebookClientSecret: string;
    callbackBaseUrl: string;
  };
  chapa: {
    secretKey: string;
    webhookSecret: string;
  };
  escrow: {
    autoReleaseHours: number;
  };
}

export function buildConfig(env: Env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    frontendOrigin: env.FRONTEND_ORIGIN,
    bffProxySecret: env.BFF_PROXY_SECRET,
    cookieDomain: env.COOKIE_DOMAIN,
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
    },
    otp: {
      ttlMinutes: env.OTP_TTL_MINUTES,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
    },
    oauth: {
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      facebookClientId: env.FACEBOOK_CLIENT_ID,
      facebookClientSecret: env.FACEBOOK_CLIENT_SECRET,
      callbackBaseUrl: env.OAUTH_CALLBACK_BASE_URL,
    },
    chapa: {
      secretKey: env.CHAPA_SECRET_KEY,
      webhookSecret: env.CHAPA_WEBHOOK_SECRET,
    },
    escrow: {
      autoReleaseHours: env.ESCROW_AUTO_RELEASE_HOURS,
    },
  };
}
