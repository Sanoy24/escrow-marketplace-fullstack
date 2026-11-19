import { IsString, Length } from 'class-validator';

export class RaiseDisputeDto {
  @IsString()
  @Length(1, 2000)
  reason!: string;
}
