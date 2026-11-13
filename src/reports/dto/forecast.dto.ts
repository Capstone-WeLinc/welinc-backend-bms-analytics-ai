import { IsString, IsOptional, IsIn, IsISO8601, IsBoolean } from 'class-validator';

export class ForecastDto {
  @IsISO8601()
  startDate: string;

  @IsISO8601()
  endDate: string;

  @IsString()
  @IsOptional()
  serviceType?: string;

  @IsString()
  @IsOptional()
  garage?: string;

  @IsString()
  @IsOptional()
  vehicleId?: string;

  @IsString()
  @IsIn(['7days', '30days', '90days', 'nextMonth'])
  forecastHorizon: '7days' | '30days' | '90days' | 'nextMonth';

  /** AI insights only: skip the cached interpretation and ask the model again. */
  @IsBoolean()
  @IsOptional()
  refreshInsights?: boolean;
}
