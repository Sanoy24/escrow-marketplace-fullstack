import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  backendJson,
  getMe,
  refreshOnce,
  setAccessToken,
  type PublicUser,
  type TokenPair,
} from './api-client';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  user: PublicUser | null;
  status: AuthStatus;
  /** Called after a successful login/signup-verify/reset-password/
   * social-exchange response — stores the access token in memory (the
   * refresh token is already an httpOnly cookie the browser holds on
   * its own; nothing here needs to touch it). */
  setSession: (user: PublicUser, tokens: TokenPair) => void;
  logout: () => Promise<void>;
  /** Re-fetches /auth/me — for after a profile-affecting action
   * (verification level change, payout account update, etc.) where the
   * in-memory user needs to reflect a mutation some other page made. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  // Boot-time silent refresh: a page reload always starts with an empty
  // in-memory access token (by design — see api-client.ts) and must
  // re-derive one from the httpOnly refresh cookie before this app can
  // know whether the visitor actually has a session.
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      const token = await refreshOnce();
      if (cancelled) return;
      if (!token) {
        setStatus('anonymous');
        return;
      }
      try {
        const me = await getMe();
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const setSession = useCallback((nextUser: PublicUser, tokens: TokenPair) => {
    setAccessToken(tokens.accessToken);
    setUser(nextUser);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    // Best-effort — same reasoning as the old frontend's logoutAction:
    // a failed revoke call shouldn't block the user from leaving.
    await backendJson('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    setAccessToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await getMe();
    setUser(me);
  }, []);

  const value = useMemo(
    () => ({ user, status, setSession, logout, refreshUser }),
    [user, status, setSession, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }
  return ctx;
}
