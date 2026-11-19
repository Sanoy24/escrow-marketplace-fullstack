import { IsPhoneNumber, IsString, Length } from 'class-validator';

export class VerifySignupDto {
  @IsPhoneNumber('ET')
  phone!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
