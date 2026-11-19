import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Conversation } from '../../db/schema';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import {
  MessagingService,
  type ConversationSummary,
  type PaginatedMessages,
} from './messaging.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Get('conversations')
  listConversations(@CurrentUser() user: AuthenticatedUser): Promise<ConversationSummary[]> {
    return this.messagingService.listConversationsForUser(user.id);
  }

  @Post('conversations')
  createConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateConversationDto,
  ): Promise<Conversation> {
    return this.messagingService.findOrCreateConversation(user.id, dto.listingId);
  }

  @Get('conversations/:id/messages')
  getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryMessagesDto,
  ): Promise<PaginatedMessages> {
    return this.messagingService.getMessages(id, user.id, query);
  }
}
