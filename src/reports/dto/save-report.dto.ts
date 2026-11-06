import { IsString, IsOptional, IsIn, IsObject, IsNotEmpty } from 'class-validator';

export class SaveReportDto {
  @IsString()
  @IsIn(['daily', 'operational', 'monthly', 'forecast'])
  reportType: 'daily' | 'operational' | 'monthly' | 'forecast';

  @IsString()
  @IsNotEmpty()
  periodKey: string;

  @IsString()
  @IsOptional()
  garage?: string;

  @IsObject()
  kpis: Record<string, unknown>;

  @IsObject()
  series: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  rawMetrics?: Record<string, unknown>;
}
