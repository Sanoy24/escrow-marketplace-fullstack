import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Send } from 'lucide-react';
import { io, type Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getAccessToken, type Message } from '@/lib/api-client';
import { relativeTime } from '@/lib/relative-time';

const WS_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3000';

interface ChatPanelProps {
  conversationId: string;
  currentUserId: string;
  initialMessages: Message[];
}

type ConnectionState = 'connecting' | 'connected' | 'error';

/**
 * Connects straight from the browser to the backend's /messaging
 * namespace, authenticated with the same in-memory access token every
 * other authenticated call in this app already uses — no `/api/ws-token`
 * hop needed. The old Next frontend's BFF had to fetch one fresh from a
 * same-origin Route Handler each time (the token never left the server
 * otherwise); here the token already lives in the browser's memory, so
 * the handshake just reads it directly. See the Phase 10 plan's
 * architecture section — this is the one place that hop disappears
 * entirely, not just moves.
 */
export function ChatPanel({ conversationId, currentUserId, initialMessages }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<ConnectionState>('connecting');
  const socketRef = useRef<Socket | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: Socket | undefined;

    function connect() {
      const token = getAccessToken();
      if (!token) {
        setState('error');
        return;
      }

      socket = io(`${WS_URL}/messaging`, {
        auth: { token },
        withCredentials: false,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket?.emit('join', { conversationId }, (ack: { ok: boolean }) => {
          if (cancelled) return;
          setState(ack.ok ? 'connected' : 'error');
        });
      });

      socket.on('connect_error', () => {
        if (!cancelled) setState('error');
      });

      socket.on('message', (message: Message) => {
        if (cancelled) return;
        setMessages((prev) =>
          prev.some((m) => m.id === message.id) ? prev : [...prev, message],
        );
      });
    }

    connect();

    return () => {
      cancelled = true;
      socket?.disconnect();
      socketRef.current = null;
    };
  }, [conversationId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !socketRef.current) return;
    socketRef.current.emit('message', { conversationId, body });
    setDraft('');
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.map((message) => {
          const mine = message.senderId === currentUserId;
          return (
            <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                  mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
                }`}
              >
                <p className="whitespace-pre-wrap">{message.body}</p>
                <p
                  className={`mt-0.5 text-[10px] ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
                >
                  {relativeTime(message.sentAt)}
                </p>
              </div>
            </div>
          );
        })}
        {messages.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Say hello — no messages yet.
          </p>
        )}
      </div>

      {state === 'connecting' && (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Connecting…
        </p>
      )}

      {state === 'error' && (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-destructive">
          <AlertCircle className="size-3.5" />
          Connection lost. Reload the page to reconnect.
        </p>
      )}

      <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-border p-2">
        <Input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a message…"
          maxLength={2000}
          disabled={state !== 'connected'}
          className="h-9 flex-1 rounded-full px-3 text-sm"
        />
        <Button type="submit" size="icon" disabled={state !== 'connected' || !draft.trim()}>
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}
