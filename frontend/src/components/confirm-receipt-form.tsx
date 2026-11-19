import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { BackendApiError, confirmEscrowReceipt } from '@/lib/api-client';

export function ConfirmReceiptForm({
  escrowTransactionId,
  onConfirmed,
}: {
  escrowTransactionId: string;
  onConfirmed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      await confirmEscrowReceipt(escrowTransactionId);
      onConfirmed();
    } catch (err) {
      setError(err instanceof BackendApiError ? err.message : 'Failed to confirm receipt.');
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" disabled={pending} className="w-full" onClick={handleClick}>
        {pending ? 'Confirming…' : 'Confirm receipt'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
