import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { BackendApiError, raiseEscrowDispute } from '@/lib/api-client';

export function DisputeForm({
  escrowTransactionId,
  onDisputed,
}: {
  escrowTransactionId: string;
  onDisputed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (!reason) {
      setError('Describe what went wrong before submitting.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await raiseEscrowDispute(escrowTransactionId, reason);
      onDisputed();
    } catch (err) {
      setError(err instanceof BackendApiError ? err.message : 'Failed to raise a dispute.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Textarea
        name="reason"
        placeholder="What went wrong? Be specific — an admin will review this against the listing and your message history."
        rows={4}
        maxLength={2000}
        required
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? 'Submitting…' : 'Raise a dispute'}
      </Button>
    </form>
  );
}
