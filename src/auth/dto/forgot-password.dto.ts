import { IsPhoneNumber } from 'class-validator';

export class ForgotPasswordDto {
  @IsPhoneNumber('ET')
  phone!: string;
}
