import { useEffect, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { EscrowStatusBadge } from '@/components/escrow-status-badge';
import { Header } from '@/components/header';
import { useAuth } from '@/lib/auth-context';
import { listMyOrders, type OrderSummary } from '@/lib/api-client';
import { santimToDisplay } from '@/lib/money';

export function MyOrdersPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listMyOrders()
      .then((result) => {
        if (!cancelled) {
          setOrders(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Helmet>
        <title>Orders — Gebeya</title>
      </Helmet>
      <Header />
      <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="mb-5 text-lg font-semibold">Orders</h1>

        {!loading && orders.length === 0 ? (
          <EmptyState
            icon={ShoppingBag}
            title="No orders yet"
            description="Pay via escrow on a listing to see it here."
            action={{ label: 'Browse listings', href: '/listings' }}
          />
        ) : (
          <div className="space-y-3">
            {orders.map((order) => (
              <Link
                key={order.id}
                to={`/orders/${order.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4 shadow-sm transition-colors hover:bg-muted"
              >
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {order.buyerId === user?.id ? "You're buying" : "You're selling"}
                  </p>
                  <p className="font-semibold">{santimToDisplay(order.totalSantim)}</p>
                </div>
                {order.escrowTransaction ? (
                  <EscrowStatusBadge status={order.escrowTransaction.status} />
                ) : (
                  <span className="text-xs text-muted-foreground">No escrow yet</span>
                )}
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
