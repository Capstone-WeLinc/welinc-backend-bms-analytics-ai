import { Module } from '@nestjs/common';
import SharedModule from '../shared/shared.module';
import { DataController } from './data.controller';

@Module({
  imports: [SharedModule],
  controllers: [DataController],
})
export class DataModule {}
