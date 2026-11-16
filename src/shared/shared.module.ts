import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ReportStorage } from './report-storage.service';

@Module({
  providers: [PrismaService, ReportStorage],
  exports: [PrismaService, ReportStorage],
})
export default class SharedModule {}
