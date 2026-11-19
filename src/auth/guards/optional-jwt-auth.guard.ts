import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like JwtAuthGuard, but never rejects the request — a missing or invalid
 * token just means `request.user` is undefined, instead of a 401. For
 * routes that are public but behave differently when the caller happens to
 * be authenticated (e.g. GET /listings/:id showing a seller their own
 * pending_review listing). Standard Nest/Passport pattern for optional
 * auth, not a bespoke one.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  override handleRequest<TUser = unknown>(_err: unknown, user: TUser | false): TUser | undefined {
    return user === false ? undefined : user;
  }
}
