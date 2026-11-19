import { IsString, MinLength } from 'class-validator';

export class SocialExchangeDto {
  @IsString()
  @MinLength(1)
  code!: string;
}
