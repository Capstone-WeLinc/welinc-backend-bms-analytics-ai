import { Module } from '@nestjs/common';
import SharedModule from '../shared/shared.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { DemandForecastService } from './forecasting/demand-forecast.service';
import { OperationalReportService } from './operational/operational-report.service';

@Module({
  imports: [SharedModule],
  controllers: [ReportsController],
  providers: [ReportsService, DemandForecastService, OperationalReportService],
})
export class ReportsModule {}
