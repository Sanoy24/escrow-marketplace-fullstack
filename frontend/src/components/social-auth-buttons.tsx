const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3000';

function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" className="size-4.5" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.707A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-4.5" aria-hidden="true">
      <path d="M22 12.06C22 6.505 17.523 2 12 2S2 6.505 2 12.06c0 5.02 3.657 9.184 8.438 9.94v-7.03H7.898v-2.91h2.54V9.845c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562v1.877h2.773l-.443 2.91h-2.33V22c4.78-.756 8.437-4.92 8.437-9.94z" />
    </svg>
  );
}

interface SocialAuthButtonsProps {
  /** "stacked" (login/signup pages) or "row" (sign-in modal — narrower, side by side). */
  layout?: 'stacked' | 'row';
}

/**
 * Real per-provider brand treatment (white+multicolor-G, Facebook blue)
 * instead of two identical plain outline buttons — same OAuth-start hrefs
 * as before, only the visual weight changed. Shared across the login and
 * signup pages so the two copies can't drift.
 */
export function SocialAuthButtons({ layout = 'stacked' }: SocialAuthButtonsProps) {
  return (
    <div className={layout === 'row' ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-2'}>
      <a
        href={`${BACKEND_URL}/auth/google`}
        className="flex h-11 items-center justify-center gap-2 rounded-lg border border-input bg-background text-base font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
      >
        <GoogleIcon />
        Continue with Google
      </a>
      <a
        href={`${BACKEND_URL}/auth/facebook`}
        className="flex h-11 items-center justify-center gap-2 rounded-lg bg-[#1877F2] text-base font-medium text-white transition-colors hover:bg-[#1877F2]/90"
      >
        <FacebookIcon />
        Continue with Facebook
      </a>
    </div>
  );
}
