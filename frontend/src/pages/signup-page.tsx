import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { SocialAuthButtons } from '@/components/social-auth-buttons';
import { VerifyCodeForm } from '@/components/verify-code-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { PhoneInput } from '@/components/ui/phone-input';
import { useAuth } from '@/lib/auth-context';
import { BackendApiError, signup, type PublicUser, type TokenPair } from '@/lib/api-client';
import { AuthLayout } from './auth-layout';

export function SignupPage() {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'details' | 'verify'>('details');
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const phoneValue = String(form.get('phone') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');
    const name = String(form.get('name') ?? '').trim();
    const email = String(form.get('email') ?? '').trim();

    if (password !== confirmPassword) {
      setPasswordMismatch(true);
      return;
    }
    setPasswordMismatch(false);
    if (!phoneValue || !password) {
      setError('Enter a phone number and password.');
      return;
    }

    setPending(true);
    setError(null);
    try {
      await signup(phoneValue, password, name || undefined, email || undefined);
      setPhone(phoneValue);
      setStep('verify');
    } catch (err) {
      setError(err instanceof BackendApiError ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  function handleVerified(user: PublicUser, tokens: TokenPair) {
    setSession(user, tokens);
    navigate('/account', { replace: true });
  }

  return (
    <AuthLayout>
      <div className="space-y-6 rounded-xl border border-border bg-background p-8 shadow-sm">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-bold">Create an account</h1>
          <p className="text-base text-muted-foreground">
            {step === 'details' ? 'Buy and sell, backed by escrow.' : 'Almost there.'}
          </p>
        </div>

        {step === 'details' ? (
          <>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="phone">Phone number</Label>
                <PhoneInput id="phone" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <PasswordInput
                  id="password"
                  name="password"
                  placeholder="Enter your password"
                  minLength={8}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <PasswordInput id="confirmPassword" name="confirmPassword" minLength={8} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">
                  Name <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input id="name" name="name" type="text" className="h-11 text-base" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">
                  Email <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input id="email" name="email" type="email" className="h-11 text-base" />
              </div>

              {passwordMismatch && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  Passwords don&apos;t match.
                </p>
              )}
              {error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={pending} className="h-11 w-full text-base">
                {pending ? 'Creating account…' : 'Create account'}
              </Button>
            </form>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or continue with</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <SocialAuthButtons />

            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link to="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </>
        ) : (
          <VerifyCodeForm phone={phone} onVerified={handleVerified} />
        )}
      </div>
    </AuthLayout>
  );
}
