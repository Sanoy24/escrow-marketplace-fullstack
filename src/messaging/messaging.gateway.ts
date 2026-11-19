import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/auth.service';
import { JoinConversationDto } from './dto/join-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagingService } from './messaging.service';

interface AuthenticatedSocket extends Socket {
  data: { userId: string };
}

/**
 * Namespace matches docs/ARCHITECTURE.md §6's documented `WS /messaging`.
 *
 * Auth runs as Socket.io connection middleware, not inside a
 * handleConnection hook — middleware is guaranteed to finish (and can
 * reject the handshake outright) before Socket.io ever emits 'connection'
 * or accepts any client event on that socket. A handleConnection-based
 * check would leave a real race: a fast client could fire 'join'/'message'
 * before the async token verification inside it resolved.
 */
@WebSocketGateway({ namespace: 'messaging' })
export class MessagingGateway implements OnGatewayInit {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MessagingGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly messagingService: MessagingService,
  ) {}

  afterInit(server: Server): void {
    server.use((socket: Socket, next: (err?: Error) => void) => {
      const token = socket.handshake.auth.token as string | undefined;
      if (!token) {
        this.logger.warn('WS connection rejected: no token in handshake.');
        next(new Error('Unauthorized'));
        return;
      }
      this.jwtService
        .verifyAsync<AccessTokenPayload>(token)
        .then((payload) => {
          // Same "type !== 'access'" defense-in-depth as JwtStrategy —
          // see src/auth/strategies/jwt.strategy.ts.
          if (payload.type !== 'access') {
            this.logger.warn('WS connection rejected: wrong token type.');
            next(new Error('Unauthorized'));
            return;
          }
          (socket as AuthenticatedSocket).data.userId = payload.sub;
          next();
        })
        .catch(() => {
          this.logger.warn('WS connection rejected: invalid or expired token.');
          next(new Error('Unauthorized'));
        });
    });
  }

  /**
   * Membership is re-checked here even though `message` re-checks it again
   * — a socket could call `message` for a conversation it never joined,
   * and `join` itself must never let a non-participant sit in a room it
   * could then receive broadcasts in.
   */
  @UsePipes(new ValidationPipe())
  @SubscribeMessage('join')
  async handleJoin(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: JoinConversationDto,
  ): Promise<{ ok: boolean }> {
    const conversation = await this.messagingService.findParticipantConversation(
      dto.conversationId,
      socket.data.userId,
    );
    if (!conversation) {
      return { ok: false };
    }
    await socket.join(dto.conversationId);
    return { ok: true };
  }

  /** Never trusts a prior `join` alone — re-verifies membership fresh. */
  @UsePipes(new ValidationPipe())
  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() dto: SendMessageDto,
  ): Promise<{ ok: boolean }> {
    const conversation = await this.messagingService.findParticipantConversation(
      dto.conversationId,
      socket.data.userId,
    );
    if (!conversation) {
      return { ok: false };
    }

    const message = await this.messagingService.createMessage(
      dto.conversationId,
      socket.data.userId,
      dto.body,
    );
    // Broadcast to the whole room, including the sender's own other
    // connected tabs, so multi-tab state stays consistent.
    this.server.to(dto.conversationId).emit('message', message);
    return { ok: true };
  }
}
