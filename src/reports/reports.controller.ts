import { Controller, Get, Post, Body, Headers, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { DemandForecastService } from './forecasting/demand-forecast.service';
import { ForecastDto } from './dto/forecast.dto';
import { SaveReportDto } from './dto/save-report.dto';
import { SaveForecastDto } from './dto/save-forecast.dto';
import { BmsAdminGuard } from '../auth/guards/bms-admin.guard';
import { OperationalReportService } from './operational/operational-report.service';
import { OperationalReportQueryDto } from './operational/operational-report.dto';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly demandForecast: DemandForecastService,
    private readonly operational: OperationalReportService,
  ) {}

  /** Operational Report: totals, closed jobs per month and jobs per vehicle for a date range and filters. */
  @Get('operational')
  @UseGuards(BmsAdminGuard)
  async operationalReport(@Query() query: OperationalReportQueryDto, @Headers('authorization') authorization?: string) {
    return this.operational.report(query, authorization);
  }

  /** Today's fleet and roster. Takes no dates or filters on purpose. */
  @Get('resources-snapshot')
  @UseGuards(BmsAdminGuard)
  async resourcesSnapshot(@Headers('authorization') authorization?: string) {
    return this.operational.resourcesSnapshot(authorization);
  }

  /** Data for all four AI Demand Forecasting tabs (forecast, services, resources, evaluation). */
  @Post('forecast')
  async forecast(@Body() dto: ForecastDto, @Headers('authorization') authorization?: string) {
    return this.demandForecast.getDashboard(dto, authorization);
  }

  /** LLM interpretation of the computed forecast; the numbers always come from /reports/forecast. */
  @Post('forecast/insights')
  async forecastInsights(@Body() dto: ForecastDto, @Headers('authorization') authorization?: string) {
    return this.demandForecast.getAiInsights(dto, authorization);
  }

  @Post('save')
  async saveReport(@Body() dto: SaveReportDto) {
    return this.reportsService.saveReport(dto);
  }

  @Post('forecast/save')
  async saveForecast(@Body() dto: SaveForecastDto) {
    return this.reportsService.saveForecast(dto);
  }

  @Get('saved')
  async getSavedReports() {
    return this.reportsService.getSavedReports();
  }
}
