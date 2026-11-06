import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { MySqlService } from './mysql.service';

@Module({
  providers: [PrismaService, MySqlService],
  exports: [PrismaService, MySqlService],
})
export default class SharedModule {}
