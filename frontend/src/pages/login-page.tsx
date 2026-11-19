import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { SocialAuthButtons } from '@/components/social-auth-buttons';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { PhoneInput } from '@/components/ui/phone-input';
import { useAuth } from '@/lib/auth-context';
import { BackendApiError, login } from '@/lib/api-client';
import { AuthLayout } from './auth-layout';

interface LocationState {
  from?: { pathname: string; search: string };
}

export function LoginPage() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const socialError = searchParams.get('error') === 'social';
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const phone = String(form.get('phone') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!phone || !password) {
      setError('Enter your phone number and password.');
      return;
    }

    setPending(true);
    setError(null);
    try {
      const { user, accessToken, refreshToken } = await login(phone, password);
      setSession(user, { accessToken, refreshToken });
      const from = (location.state as LocationState | null)?.from;
      navigate(from ? `${from.pathname}${from.search}` : '/account', { replace: true });
    } catch (err) {
      setError(err instanceof BackendApiError ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout>
      <div className="space-y-6 rounded-xl border border-border bg-background p-8 shadow-sm">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-bold">Welcome back 👋</h1>
          <p className="text-base text-muted-foreground">Log in to your Gebeya account</p>
        </div>

        {socialError && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            That sign-in link didn&apos;t work. Please try again.
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone number</Label>
            <PhoneInput id="phone" required />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link to="/forgot-password" className="text-xs text-primary hover:underline">
                Forgot password?
              </Link>
            </div>
            <PasswordInput
              id="password"
              name="password"
              placeholder="Enter your password"
              required
            />
          </div>

          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={pending} className="h-11 w-full text-base">
            {pending ? 'Logging in…' : 'Log in'}
          </Button>
        </form>

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or continue with</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <SocialAuthButtons />

        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link to="/signup" className="text-primary hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
