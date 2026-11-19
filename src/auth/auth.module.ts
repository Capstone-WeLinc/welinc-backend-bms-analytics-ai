import { Module } from '@nestjs/common';
import { BmsAuthModule } from './bms-auth.module';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
@Module({imports:[BmsAuthModule],providers:[JwtAuthGuard],exports:[BmsAuthModule,JwtAuthGuard]})
export default class AuthModule {}
