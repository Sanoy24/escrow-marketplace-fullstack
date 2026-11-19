import { Badge } from '@/components/ui/badge';
import type { EscrowStatus } from '@/lib/api-client';

// Mirrors ExchangeStatusBadge/ListingStatusBadge's status->color/label
// pattern. pending_payment and held share the "warning" token on purpose
// — both are still-open states that need someone's action or Chapa's
// webhook to land, distinguished by label text rather than a color the
// existing palette has no token for.
const STATUS_STYLES: Record<EscrowStatus, string> = {
  pending_payment: 'bg-warning/20 text-warning-foreground border-transparent',
  held: 'bg-warning/20 text-warning-foreground border-transparent',
  released: 'bg-success/15 text-success border-transparent',
  disputed: 'bg-destructive/15 text-destructive border-transparent',
  refunded: 'bg-muted text-muted-foreground border-transparent',
};

const STATUS_LABELS: Record<EscrowStatus, string> = {
  pending_payment: 'Awaiting payment',
  held: 'In escrow',
  released: 'Released',
  disputed: 'Disputed',
  refunded: 'Refunded',
};

export function EscrowStatusBadge({ status }: { status: EscrowStatus }) {
  return <Badge className={STATUS_STYLES[status]}>{STATUS_LABELS[status]}</Badge>;
}
