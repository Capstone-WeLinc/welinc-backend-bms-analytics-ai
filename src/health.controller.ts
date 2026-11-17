import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './shared/prisma.service';
import { ReportStorage } from './shared/report-storage.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ReportStorage,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.checkReady();
      return { status: 'ok', postgres: 'ok', reports: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Analytics database is unavailable');
    }
  }
}
