import { IsString, IsOptional, IsIn, IsISO8601 } from 'class-validator';

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
  @IsIn(['7days', '30days', '90days'])
  forecastHorizon: '7days' | '30days' | '90days';
}
