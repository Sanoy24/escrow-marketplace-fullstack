import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsPhoneNumber('ET')
  phone!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
