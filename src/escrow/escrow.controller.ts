import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { EscrowTransaction, Review } from '../../db/schema';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateReviewDto } from '../reviews/dto/create-review.dto';
import { ReviewsService } from '../reviews/reviews.service';
import { CreateEscrowDto } from './dto/create-escrow.dto';
import { RaiseDisputeDto } from './dto/raise-dispute.dto';
import { EscrowService } from './escrow.service';

@Controller('escrow')
export class EscrowController {
  constructor(
    private readonly escrowService: EscrowService,
    private readonly reviewsService: ReviewsService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEscrowDto,
  ): Promise<{ escrowTransaction: EscrowTransaction; checkoutUrl: string }> {
    return this.escrowService.initiate(user.id, dto);
  }

  /**
   * No JwtAuthGuard — this is Chapa calling us, not a logged-in user.
   * Authenticity comes entirely from the signature check inside
   * EscrowService.handleWebhook, verified against the untouched raw
   * bytes (req.rawBody), never the re-serialized parsed body.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('chapa-signature') chapaSignature: string | undefined,
    @Headers('x-chapa-signature') xChapaSignature: string | undefined,
  ): Promise<{ received: true }> {
    if (!req.rawBody) {
      throw new BadRequestException('Missing request body.');
    }
    await this.escrowService.handleWebhook(
      req.rawBody.toString('utf8'),
      chapaSignature ?? xChapaSignature,
    );
    return { received: true };
  }

  @Post(':id/confirm-receipt')
  @UseGuards(JwtAuthGuard)
  confirmReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EscrowTransaction> {
    return this.escrowService.confirmReceipt(id, user.id);
  }

  @Post(':id/dispute')
  @UseGuards(JwtAuthGuard)
  dispute(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RaiseDisputeDto,
  ): Promise<EscrowTransaction> {
    return this.escrowService.raiseDispute(id, user.id, dto);
  }

  @Post(':id/review')
  @UseGuards(JwtAuthGuard)
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReviewDto,
  ): Promise<Review> {
    return this.reviewsService.submit(id, user.id, dto);
  }
}
