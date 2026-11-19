export const ESCROW_AUTO_RELEASE_QUEUE = 'escrow-auto-release';

export interface EscrowAutoReleaseJobData {
  escrowTransactionId: string;
}

/**
 * Basis points, not a percentage (docs/CODE_GUIDELINES.md §1). 300 = 3%,
 * a business decision, hard-coded here rather than left as a runtime
 * default anyone could silently override.
 */
export const ESCROW_PLATFORM_FEE_BPS = 300n;

/**
 * The business-tier discount: 200 = 2%, applied instead of
 * ESCROW_PLATFORM_FEE_BPS when the seller is `business`-verified at
 * release time. See EscrowService#releaseFunds.
 */
export const ESCROW_PLATFORM_FEE_BPS_BUSINESS = 200n;
