import { DatabasePool } from './database-pool';
import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ReportStorage } from './report-storage.service';

@Module({
  providers: [DatabasePool, PrismaService, ReportStorage],
  exports: [DatabasePool, PrismaService, ReportStorage],
})
export default class SharedModule {}
