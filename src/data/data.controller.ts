import {
  Controller,
  Get,
  UseGuards,
  Headers,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";

/**
 * Read-only data endpoints that the standalone Reports page requires
 * (GET /data/booking, /data/vehicles, /data/drivers). Mirrors the BMS services'
 * booking/vehicle/driver list endpoints so the analytics page gets the
 * exact same data shapes.
 */
@Controller("data")
@UseGuards(JwtAuthGuard)
export class DataController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("booking")
  async getBookings() {
    const bookings = await this.prisma.booking.findMany({
      orderBy: { createdAt: "desc" },
      include: { scheduledBooking: true },
    });
    return bookings.map((booking) => {
      const { scheduledBooking, ...details } = booking;
      const formatted: any = {
        ...details,
        garage: scheduledBooking?.garage ?? null,
        deliveryType: scheduledBooking?.deliveryType ?? null,
        vehicleId: scheduledBooking?.vehicleId ?? null,
        driverId: scheduledBooking?.driverId ?? null,
        helperIds: scheduledBooking?.helperIds ?? [],
        amount: booking.amount !== null ? Number(booking.amount) : null,
        overtimeHours:
          booking.overtimeHours !== null ? Number(booking.overtimeHours) : null,
        overtimeCharge:
          booking.overtimeCharge !== null
            ? Number(booking.overtimeCharge)
            : null,
        amountPaid:
          booking.amountPaid !== null ? Number(booking.amountPaid) : null,
      };

      // Map snake_case Prisma fields to camelCase expected by the frontend
      if ("payment_status" in booking) {
        formatted.paymentStatus = booking.payment_status;
        delete formatted.payment_status;
      }
      if ("payment_method" in booking) {
        formatted.paymentMethod = booking.payment_method;
        delete formatted.payment_method;
      }

      return formatted;
    });
  }

  private async dispatch(path: string, authorization: string | undefined) {
    let res: Response;
    try {
      res = await fetch(
        new URL(
          path,
          process.env.DISPATCH_API_URL ?? "http://bms-dispatch:3022",
        ),
        {
          headers: authorization ? { authorization } : {},
          signal: AbortSignal.timeout(3000),
        },
      );
    } catch {
      throw new ServiceUnavailableException("Dispatch unavailable");
    }
    if (!res.ok) throw new ServiceUnavailableException("Dispatch unavailable");
    return res.json();
  }
  @Get("vehicles")
  getVehicles(@Headers("authorization") authorization: string) {
    return this.dispatch("/bms/config/vehicles", authorization);
  }
  @Get("drivers")
  getDrivers(@Headers("authorization") authorization: string) {
    return this.dispatch("/bms/config/drivers", authorization);
  }
  @Get("helpers")
  getHelpers(@Headers("authorization") authorization: string) {
    return this.dispatch("/bms/config/helpers", authorization);
  }
}
