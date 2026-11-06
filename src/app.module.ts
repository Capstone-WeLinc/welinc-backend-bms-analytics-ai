import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import SharedModule from './shared/shared.module';
import AuthModule from './auth/auth.module';
import { ReportsModule } from './reports/reports.module';
import { DataModule } from './data/data.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SharedModule,
    AuthModule,
    ReportsModule,
    DataModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
