import { IsUUID } from 'class-validator';

export class CreateEscrowDto {
  @IsUUID()
  orderId!: string;
}
