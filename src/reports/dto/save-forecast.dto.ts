import { IsString, IsOptional, IsIn, IsInt, IsArray, IsNotEmpty, Min, Max } from 'class-validator';

export class SaveForecastDto {
  @IsString()
  @IsIn(['7days', '30days', '90days'])
  forecastHorizon: '7days' | '30days' | '90days';

  @IsString()
  @IsNotEmpty()
  periodStart: string;

  @IsString()
  @IsNotEmpty()
  periodEnd: string;

  @IsString()
  @IsOptional()
  serviceType?: string;

  @IsString()
  @IsOptional()
  garage?: string;

  @IsInt()
  @Min(0)
  predictedBookings: number;

  @IsInt()
  @Min(0)
  @Max(100)
  confidence: number;

  @IsArray()
  forecastData: Array<Record<string, unknown>>;

  @IsArray()
  @IsOptional()
  recommendations?: string[];

  @IsString()
  @IsOptional()
  summaryText?: string;
}
