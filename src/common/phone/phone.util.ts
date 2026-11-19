import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Thrown for a phone number that fails validation. Distinct from a generic
 * error so callers (e.g. a Nest exception filter) can map it to a 400
 * without string-matching an error message.
 */
export class InvalidPhoneNumberError extends Error {
  constructor(input: string) {
    super(`"${input}" is not a valid phone number`);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Normalizes a phone number to E.164 (e.g. "+251912345678").
 *
 * Ethiopian users enter the same number as "0912345678", "251912345678",
 * "+251 91 234 5678", or with dashes — all the same subscriber. Without
 * collapsing to one canonical form at the boundary, `UNIQUE(phone)` doesn't
 * actually prevent duplicate accounts, and OTPs can be sent to a number the
 * user isn't logged in as. This is the single normalization point; every
 * caller downstream (DB writes, DB lookups, SMS delivery) must go through it
 * rather than re-deriving its own notion of "the same number".
 *
 * Rejects rather than coerces: a typo'd phone number is an unrecoverable
 * account, so an ambiguous or invalid input throws instead of silently
 * producing a best-effort guess.
 */
export function normalizePhoneToE164(input: string, defaultRegion: 'ET' = 'ET'): string {
  const parsed = parsePhoneNumberFromString(input, defaultRegion);
  if (
    !parsed ||
    !parsed.isValid() ||
    parsed.country !== defaultRegion ||
    parsed.getType() !== 'MOBILE'
  ) {
    throw new InvalidPhoneNumberError(input);
  }
  return parsed.number;
}

/**
 * Masks a phone number for logging — keeps only the last 4 digits.
 * Used at every application log call site instead of relying solely on
 * pino's path-based redaction, which only covers the fixed shape of the
 * auto-logged HTTP request/response, not ad-hoc log objects. See
 * docs/CODE_GUIDELINES.md §6.
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return `****${phone.slice(-4)}`;
}
