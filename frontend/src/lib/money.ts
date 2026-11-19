// priceSantim arrives from the backend as a numeric string (bigint,
// serialized via backend/src/common/bigint-json.ts) — this is the only
// place that turns it into a display string. Never trust a pre-formatted
// price over the wire; see docs/CODE_GUIDELINES.md §10.

/**
 * "4500050" -> "45,000.50 ETB". Drops the fractional part entirely when
 * it's zero ("4500000" -> "45,000 ETB") — most listings are priced in
 * whole birr, and showing ".00" on every card is visual noise the design
 * guide's "minimal chrome" principle argues against.
 */
const SANTIM_PER_ETB = BigInt(100);

export function santimToDisplay(santim: string): string {
  const value = BigInt(santim);
  const whole = value / SANTIM_PER_ETB;
  const fraction = value % SANTIM_PER_ETB;

  const wholeFormatted = whole.toLocaleString('en-US');
  if (fraction === BigInt(0)) {
    return `${wholeFormatted} ETB`;
  }
  const fractionFormatted = fraction.toString().padStart(2, '0');
  return `${wholeFormatted}.${fractionFormatted} ETB`;
}
