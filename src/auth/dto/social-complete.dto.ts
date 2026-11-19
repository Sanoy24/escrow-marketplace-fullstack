import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class SocialCompleteDto {
  @IsString()
  @MinLength(1)
  pendingToken!: string;

  @IsPhoneNumber('ET')
  phone!: string;
}
