import { IsOptional, IsString, MinLength } from 'class-validator';

export class RefreshDto {
  // Optional as of Phase 10: a browser SPA calling this with
  // credentials:'include' never has the (httpOnly) refresh token to put
  // in a body — the controller falls back to the refresh_token cookie
  // when this is omitted. Still accepted in the body for the original
  // BFF-style caller, which has no cookie of its own to send here.
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}
