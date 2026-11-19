/**
 * Thrown for a price string that isn't a valid decimal ETB amount. Distinct
 * from a generic error so callers can map it to a 400 without string-
 * matching a message.
 */
export class InvalidMoneyInputError extends Error {
  constructor(input: string) {
    super(`"${input}" is not a valid ETB amount`);
    this.name = 'InvalidMoneyInputError';
  }
}

const DECIMAL_ETB_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Parses a decimal ETB string (e.g. "1500", "1500.50") into an integer
 * count of santim — never a float, per docs/CODE_GUIDELINES.md §1.
 * Deliberately never `parseFloat`: that silently accepts garbage like
 * "1500abc" (parses to 1500) and loses precision on large amounts. Rejects
 * anything that isn't a plain non-negative decimal with at most 2 places.
 */
export function parseEtbToSantim(input: string): bigint {
  const trimmed = input.trim();
  if (!DECIMAL_ETB_PATTERN.test(trimmed)) {
    throw new InvalidMoneyInputError(input);
  }

  // Avoid destructuring trimmed.split('.') — noUncheckedIndexedAccess
  // can't know from the regex test above that the whole part is always
  // present, so it'd type wholePart as `string | undefined`.
  const dotIndex = trimmed.indexOf('.');
  const wholePart = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  const fractionPart = dotIndex === -1 ? '' : trimmed.slice(dotIndex + 1);
  const santimFraction = fractionPart.padEnd(2, '0');

  return BigInt(wholePart) * 100n + BigInt(santimFraction);
}

/**
 * The inverse of parseEtbToSantim — converts a stored santim integer to a
 * decimal ETB string, only at a boundary that requires it (the Chapa API
 * call and the UI, per docs/CODE_GUIDELINES.md §1). Never used mid-
 * calculation; every internal computation stays in bigint santim.
 */
export function formatSantimToEtb(amountSantim: bigint): string {
  const whole = amountSantim / 100n;
  const fraction = amountSantim % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}
