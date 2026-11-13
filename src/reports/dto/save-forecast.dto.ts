import { IsString, IsOptional, IsIn, IsInt, IsArray, IsNotEmpty, Min, Max } from 'class-validator';

export class SaveForecastDto {
  @IsString()
  @IsIn(['7days', '30days', '90days', 'nextMonth'])
  forecastHorizon: '7days' | '30days' | '90days' | 'nextMonth';

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

  /** Only set when backed by an evaluation; never a made-up score. */
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  confidence?: number | null;

  @IsArray()
  forecastData: Array<Record<string, unknown>>;

  @IsArray()
  @IsOptional()
  recommendations?: string[];

  @IsString()
  @IsOptional()
  summaryText?: string;
}
