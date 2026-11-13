import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /reports/operational?from=&to=&serviceId=&vehicleId= (dates are Asia/Manila days, inclusive). */
export class OperationalReportQueryDto {
  @Matches(DAY, { message: 'from must be a date like 2026-11-10' })
  from: string;

  @Matches(DAY, { message: 'to must be a date like 2026-11-10' })
  to: string;

  /** A service name such as "Lipat Bahay", or "All". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serviceId?: string;

  /** A vehicle id from /bms/config/vehicles, or "All". */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vehicleId?: string;
}
