import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../config/configuration';

/**
 * Phase 10 (frontend migration, Vite SPA with no server of its own —
 * see docs/ARCHITECTURE.md's BFF-removal section): the backend now sets
 * the refresh token itself as an httpOnly cookie, in ADDITION to
 * returning both tokens in the JSON body as it always has. This is
 * purely additive — nothing reads this cookie except this backend's own
 * /auth/refresh and /auth/logout, and the old Next BFF frontend keeps
 * working unchanged since it never looks at response cookies, only the
 * JSON body it already consumed.
 *
 * The access token deliberately never gets a cookie here — the SPA
 * keeps it in memory only (see the plan's access-token-in-memory
 * design); only the longer-lived refresh token needs to survive a page
 * reload, which is the one thing an httpOnly cookie is for.
 */
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

function cookieOptions(config: Pick<AppConfig, 'nodeEnv' | 'cookieDomain'>): CookieOptions {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    ...(config.cookieDomain && { domain: config.cookieDomain }),
  };
}

export function setRefreshCookie(
  res: Response,
  token: string,
  config: Pick<AppConfig, 'nodeEnv' | 'cookieDomain' | 'jwt'>,
): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    ...cookieOptions(config),
    maxAge: config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(
  res: Response,
  config: Pick<AppConfig, 'nodeEnv' | 'cookieDomain'>,
): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, cookieOptions(config));
}
