import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { AuthService, type PublicUser, type SocialProfile, type TokenPair } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SignupDto } from './dto/signup.dto';
import { SocialCompleteDto } from './dto/social-complete.dto';
import { SocialExchangeDto } from './dto/social-exchange.dto';
import { VerifySignupDto } from './dto/verify-signup.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { clearRefreshCookie, REFRESH_TOKEN_COOKIE, setRefreshCookie } from './refresh-cookie.util';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.OK)
  // SMS-sending endpoint — same cost/abuse profile as the old OTP request.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async signup(@Body() dto: SignupDto): Promise<{ message: string }> {
    await this.authService.signup(dto.phone, dto.password, dto.name, dto.email);
    return { message: 'Account created. A verification code has been sent.' };
  }

  @Post('signup/verify')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verifySignup(
    @Body() dto: VerifySignupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: PublicUser } & TokenPair> {
    const result = await this.authService.verifySignup(dto.phone, dto.code);
    this.setRefreshCookieFromResult(res, result);
    return result;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: PublicUser } & TokenPair> {
    const result = await this.authService.login(dto.phone, dto.password);
    this.setRefreshCookieFromResult(res, result);
    return result;
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.authService.forgotPassword(dto.phone);
    return { message: 'If this number is registered, a reset code has been sent.' };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair> {
    const result = await this.authService.resetPassword(dto.phone, dto.code, dto.newPassword);
    this.setRefreshCookieFromResult(res, result);
    return result;
  }

  @Post('social/exchange')
  @HttpCode(HttpStatus.OK)
  async exchangeSocialCode(
    @Body() dto: SocialExchangeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: PublicUser } & TokenPair> {
    const result = await this.authService.exchangeSocialCode(dto.code);
    this.setRefreshCookieFromResult(res, result);
    return result;
  }

  @Post('social/complete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async completeSocialSignup(@Body() dto: SocialCompleteDto): Promise<{ message: string }> {
    await this.authService.completeSocialSignup(dto.pendingToken, dto.phone);
    return { message: 'A verification code has been sent.' };
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleAuth(): void {
    // Passport's guard redirects to Google's consent screen; nothing to do here.
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handleSocialCallback(req, res);
  }

  @Get('facebook')
  @UseGuards(AuthGuard('facebook'))
  facebookAuth(): void {
    // Passport's guard redirects to Facebook's consent screen; nothing to do here.
  }

  @Get('facebook/callback')
  @UseGuards(AuthGuard('facebook'))
  async facebookCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handleSocialCallback(req, res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair> {
    const token = this.resolveRefreshToken(dto, req);
    const result = await this.authService.refresh(token);
    this.setRefreshCookieFromResult(res, result);
    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = this.resolveRefreshToken(dto, req);
    await this.authService.logout(token);
    clearRefreshCookie(res, {
      nodeEnv: this.configService.get('nodeEnv', { infer: true }),
      cookieDomain: this.configService.get('cookieDomain', { infer: true }),
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<PublicUser> {
    return this.authService.getPublicUser(user.id);
  }

  /**
   * Shared by both providers' callback routes. The frontend contract (see
   * docs/ARCHITECTURE.md §6): a successful match redirects to
   * `/auth/social-callback?code=...` (exchanged server-to-server for real
   * tokens — see AuthService.exchangeSocialCode); no match yet redirects to
   * `/signup/social?pendingToken=...` (collects+verifies a phone — see
   * AuthService.completeSocialSignup).
   */
  private async handleSocialCallback(req: Request, res: Response): Promise<void> {
    const profile = req.user as SocialProfile;
    const frontendOrigin = this.configService.get('frontendOrigin', { infer: true });
    const result = await this.authService.handleSocialLogin(profile);

    const redirectUrl =
      result.kind === 'authenticated'
        ? `${frontendOrigin}/auth/social-callback?code=${encodeURIComponent(result.code)}`
        : `${frontendOrigin}/signup/social?pendingToken=${encodeURIComponent(result.pendingToken)}`;
    res.redirect(redirectUrl);
  }

  /** Shared by every endpoint that hands back a fresh token pair — see
   * refresh-cookie.util.ts's own comment for why only the refresh token
   * gets a cookie. */
  private setRefreshCookieFromResult(res: Response, result: TokenPair): void {
    setRefreshCookie(res, result.refreshToken, {
      nodeEnv: this.configService.get('nodeEnv', { infer: true }),
      cookieDomain: this.configService.get('cookieDomain', { infer: true }),
      jwt: this.configService.get('jwt', { infer: true }),
    });
  }

  /** Body wins when present (the original BFF-style caller, which has no
   * cookie of its own to send here); falls back to the httpOnly cookie a
   * browser SPA can't read but does send automatically. 400s rather than
   * letting a `undefined` reach the service and fail confusingly deeper
   * in the call stack. */
  private resolveRefreshToken(dto: RefreshDto, req: Request): string {
    const token = dto.refreshToken ?? (req.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined);
    if (!token) {
      throw new BadRequestException('No refresh token provided.');
    }
    return token;
  }
}
