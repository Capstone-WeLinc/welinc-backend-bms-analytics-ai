import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { ForecastDto } from './dto/forecast.dto';
import { SaveReportDto } from './dto/save-report.dto';
import { SaveForecastDto } from './dto/save-forecast.dto';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post('forecast')
  async forecast(@Body() dto: ForecastDto) {
    return this.reportsService.getForecast(dto);
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
