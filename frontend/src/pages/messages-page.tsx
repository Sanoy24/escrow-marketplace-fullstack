import { useEffect, useState } from 'react';
import { ImageOff, MessageCircle } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Header } from '@/components/header';
import { listConversations, type ConversationSummary } from '@/lib/api-client';
import { relativeTime } from '@/lib/relative-time';

export function MessagesPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listConversations()
      .then((result) => {
        if (!cancelled) {
          setConversations(result);
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
        <title>Messages — Gebeya</title>
      </Helmet>
      <Header />
      <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-lg font-semibold">Messages</h1>

        {!loading && conversations.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title="No conversations yet"
            description="Message a seller from a listing to start one."
            action={{ label: 'Browse listings', href: '/listings' }}
          />
        ) : (
          <ul className="divide-y divide-border">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  to={`/messages/${conversation.id}`}
                  className="flex items-center gap-3 py-3 hover:bg-muted/50"
                >
                  <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                    {conversation.listing.primaryImageUrl ? (
                      <img
                        src={conversation.listing.primaryImageUrl}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <ImageOff className="size-5 text-muted-foreground/50" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-medium">
                        {conversation.otherParticipant.name ?? conversation.otherParticipant.phone}
                      </p>
                      {conversation.lastMessage && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {relativeTime(conversation.lastMessage.sentAt)}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {conversation.listing.title}
                    </p>
                    {conversation.lastMessage && (
                      <p className="truncate text-sm text-foreground/80">
                        {conversation.lastMessage.body}
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
