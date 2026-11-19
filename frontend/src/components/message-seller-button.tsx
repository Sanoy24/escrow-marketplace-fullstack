import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router';
import { SignInModal } from '@/components/sign-in-modal';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { createConversation } from '@/lib/api-client';

interface MessageSellerButtonProps {
  listingId: string;
}

export function MessageSellerButton({ listingId }: MessageSellerButtonProps) {
  const { status } = useAuth();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function messageSeller() {
    setPending(true);
    try {
      const conversation = await createConversation(listingId);
      navigate(`/messages/${conversation.id}`);
    } finally {
      setPending(false);
    }
  }

  function handleClick() {
    if (status === 'authenticated') {
      void messageSeller();
    } else {
      setModalOpen(true);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="lg"
        disabled={pending}
        className="flex-1 gap-2"
        onClick={handleClick}
      >
        <MessageCircle className="size-4" />
        Message seller
      </Button>
      <SignInModal open={modalOpen} onOpenChange={setModalOpen} onSuccess={() => void messageSeller()} />
    </>
  );
}
