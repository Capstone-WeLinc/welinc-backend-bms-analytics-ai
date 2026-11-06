import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './shared/prisma.service';
import { MySqlService } from './shared/mysql.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mysql: MySqlService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      await this.mysql.query('SELECT 1');
      return { status: 'ok', postgres: 'ok', mysql: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Analytics database is unavailable');
    }
  }
}
