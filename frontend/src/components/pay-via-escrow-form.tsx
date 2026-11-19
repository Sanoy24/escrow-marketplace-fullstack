import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BackendApiError, createOrder, initiateEscrow } from '@/lib/api-client';

/**
 * One click, two backend calls: v1 orders are always a single listing
 * (Store-scoped combined checkout only exists on the store page's own
 * StoreCheckout). Ends in a full top-level navigation to Chapa's hosted
 * checkout — `window.location.href`, not react-router's navigate(), since
 * this is leaving the SPA entirely for an external payment page.
 */
export function PayViaEscrowForm({ listingId }: { listingId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const order = await createOrder([listingId]);
      const { checkoutUrl } = await initiateEscrow(order.id);
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof BackendApiError ? err.message : 'Failed to start escrow payment.');
      setPending(false);
    }
  }

  return (
    <div className="flex-1 space-y-2">
      <Button type="button" size="lg" disabled={pending} className="w-full gap-2" onClick={handleClick}>
        <ShieldCheck className="size-4" />
        {pending ? 'Starting payment…' : 'Pay via escrow'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
