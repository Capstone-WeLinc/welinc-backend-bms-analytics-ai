import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssignmentInput, BookingInput, CrewInput, JobOrderInput, OperationalReport, PostServiceInput, ResourcesSnapshot, VehicleInput,
  computeOperationalReport, computeResourcesSnapshot,
} from './operational-report';
import { OperationalReportQueryDto } from './operational-report.dto';

/** Longest range the report accepts, so a typo cannot ask for decades of months. */
const MAX_RANGE_DAYS = 366 * 5;

/**
 * Reads bookings, assignments, job orders, completion records and the fleet from
 * the services that own them, with the Admin's own token, and hands them to the
 * pure calculations in ./operational-report.ts.
 */
@Injectable()
export class OperationalReportService {
  private readonly logger = new Logger(OperationalReportService.name);

  constructor(private readonly config: ConfigService) {}

  async report(query: OperationalReportQueryDto, authorization: string | undefined): Promise<OperationalReport> {
    if (query.from > query.to) throw new BadRequestException('The start date must be on or before the end date.');
    if ((Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new BadRequestException('Choose a range of five years or less.');
    }
    const [bookings, assignments, jobOrders, vehicles, postService] = await Promise.all([
      this.get<BookingInput[]>('booking', '/booking', authorization),
      this.get<AssignmentInput[]>('dispatch', '/dispatch/assignments', authorization),
      this.get<JobOrderInput[]>('dispatch', '/job-order', authorization),
      this.get<VehicleInput[]>('dispatch', '/bms/config/vehicles', authorization),
      // Only used for completion dates; without it a completed booking's last update is used.
      this.get<PostServiceInput[]>('completion', '/post-service', authorization).catch(() => [] as PostServiceInput[]),
    ]);
    return computeOperationalReport({ bookings, assignments, jobOrders, postService, vehicles }, query);
  }

  async resourcesSnapshot(authorization: string | undefined): Promise<ResourcesSnapshot> {
    const [vehicles, drivers, helpers] = await Promise.all([
      // The real, active fleet with today's assignment flag. The availability endpoint also
      // returns display-only sample vehicles whose statuses are not real, so it is not used here.
      this.get<VehicleInput[]>('dispatch', '/bms/config/vehicles', authorization),
      this.get<CrewInput[]>('dispatch', '/bms/config/drivers', authorization),
      this.get<CrewInput[]>('dispatch', '/bms/config/helpers', authorization),
    ]);
    return computeResourcesSnapshot({ vehicles, drivers, helpers });
  }

  private async get<T>(service: 'booking' | 'dispatch' | 'completion', path: string, authorization: string | undefined): Promise<T> {
    const base = {
      booking: this.config.get<string>('BOOKING_API_URL') || 'http://127.0.0.1:3021',
      dispatch: this.config.get<string>('DISPATCH_API_URL') || 'http://127.0.0.1:3022',
      completion: this.config.get<string>('COMPLETION_API_URL') || 'http://127.0.0.1:3023',
    }[service];
    try {
      const response = await fetch(new URL(path, base), { headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      const body = await response.json();
      return (Array.isArray(body) ? body : []) as T;
    } catch (error) {
      this.logger.warn(`Operational report source unavailable: ${error instanceof Error ? error.message : error}`);
      throw new ServiceUnavailableException('Some report records couldn’t be loaded. Try again in a moment.');
    }
  }
}
