import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useParams } from 'react-router';
import { ConfirmReceiptForm } from '@/components/confirm-receipt-form';
import { DisputeForm } from '@/components/dispute-form';
import { EscrowStatusBadge } from '@/components/escrow-status-badge';
import { Header } from '@/components/header';
import { ReviewForm } from '@/components/review-form';
import { buttonVariants } from '@/components/ui/button';
import {
  BackendApiError,
  getOrder,
  type Delivery,
  type EscrowTransaction,
  type OrderDetail,
} from '@/lib/api-client';
import { santimToDisplay } from '@/lib/money';

const DELIVERY_STATUS_LABELS: Record<Delivery['status'], string> = {
  pending_assignment: 'Waiting for the seller to assign a driver',
  assigned: 'A driver has been assigned',
  picked_up: 'Picked up — on its way',
  delivered: 'Delivered',
};

type LoadState = 'loading' | 'ready' | 'not-found' | 'error';

export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>('loading');
  const [order, setOrder] = useState<OrderDetail | null>(null);
  // Bumped to trigger a refetch after an escrow action (confirm/dispute/
  // review) changes the order's state — simpler than exposing the fetch
  // function itself across the effect boundary.
  const [refreshKey, setRefreshKey] = useState(0);
  const refetch = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setState('loading');
      try {
        const fetched = await getOrder(id!);
        if (cancelled) return;
        setOrder(fetched);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        setState(err instanceof BackendApiError && err.status === 404 ? 'not-found' : 'error');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, refreshKey]);

  if (state === 'loading') {
    return (
      <>
        <Header />
        <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </>
    );
  }

  if (state === 'not-found' || state === 'error') {
    return (
      <>
        <Header />
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-lg font-medium">
            {state === 'not-found' ? 'Order not found' : 'Something went wrong'}
          </p>
          <Link to="/account/orders" className={buttonVariants({ variant: 'outline' })}>
            Back to orders
          </Link>
        </div>
      </>
    );
  }

  const data = order!;
  // The frontend always initiates escrow in the same call that creates
  // the order, so escrowTransaction is only ever absent if the buyer
  // navigated back before that call completed.
  const escrowTransaction = data.escrowTransaction;

  return (
    <>
      <Helmet>
        <title>Order — Gebeya</title>
      </Helmet>
      <Header />
      <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-xl font-semibold">Order</h1>

        <div className="mb-6 space-y-3 rounded-lg border border-border p-4">
          {data.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Item</span>
              <span className="font-medium">{santimToDisplay(item.priceAtPurchaseSantim)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{santimToDisplay(data.subtotalSantim)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Delivery</span>
            <span>{santimToDisplay(data.deliveryFeeSantim)}</span>
          </div>
          <div className="flex items-center justify-between text-base font-semibold">
            <span>Total</span>
            <span>{santimToDisplay(data.totalSantim)}</span>
          </div>
        </div>

        {data.deliveries.length > 0 && (
          <div className="mb-6 space-y-1 text-sm text-muted-foreground">
            {data.deliveries.length === 1 ? (
              <p>Delivery: {DELIVERY_STATUS_LABELS[data.deliveries[0]!.status]}</p>
            ) : (
              data.deliveries.map((delivery, index) => (
                <p key={delivery.id}>
                  Delivery {index + 1} of {data.deliveries.length}:{' '}
                  {DELIVERY_STATUS_LABELS[delivery.status]}
                </p>
              ))
            )}
          </div>
        )}

        {escrowTransaction ? (
          <EscrowSection order={data} escrowTransaction={escrowTransaction} onChanged={refetch} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Escrow hasn&apos;t been started on this order yet.
          </p>
        )}
      </main>
    </>
  );
}

interface EscrowSectionProps {
  order: OrderDetail;
  escrowTransaction: EscrowTransaction;
  onChanged: () => void;
}

function EscrowSection({ order, escrowTransaction, onChanged }: EscrowSectionProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Escrow status</h2>
        <EscrowStatusBadge status={escrowTransaction.status} />
      </div>

      {escrowTransaction.status === 'pending_payment' && (
        <p className="text-sm text-muted-foreground">
          Waiting for Chapa to confirm your payment. This page will update once it does — you can
          safely leave and come back.
        </p>
      )}

      {escrowTransaction.status === 'held' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Payment is safely held. Confirm once you&apos;ve received the item, or it releases
            automatically if neither side acts.
          </p>
          <ConfirmReceiptForm escrowTransactionId={escrowTransaction.id} onConfirmed={onChanged} />
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium">Something wrong with this order?</p>
            <DisputeForm escrowTransactionId={escrowTransaction.id} onDisputed={onChanged} />
          </div>
        </div>
      )}

      {escrowTransaction.status === 'disputed' && (
        <p className="text-sm text-muted-foreground">
          This order is disputed. An admin is reviewing it against the listing and your message
          history — no further action is needed from you right now.
        </p>
      )}

      {escrowTransaction.status === 'released' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Funds have been released to the seller
            {escrowTransaction.platformFeeSantim &&
              ` (platform fee: ${santimToDisplay(escrowTransaction.platformFeeSantim)})`}
            .
          </p>
          {!order.hasReviewed && (
            <ReviewForm escrowTransactionId={escrowTransaction.id} onSubmitted={onChanged} />
          )}
        </div>
      )}

      {escrowTransaction.status === 'refunded' && (
        <p className="text-sm text-muted-foreground">
          This order was disputed and refunded to the buyer.
        </p>
      )}
    </div>
  );
}
