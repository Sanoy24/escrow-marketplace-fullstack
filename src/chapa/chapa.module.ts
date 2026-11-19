import { Module } from '@nestjs/common';
import { ChapaHttpDriver } from './chapa-http.driver';
import { CHAPA_SERVICE } from './chapa.interface';

@Module({
  providers: [{ provide: CHAPA_SERVICE, useClass: ChapaHttpDriver }],
  exports: [CHAPA_SERVICE],
})
export class ChapaModule {}
