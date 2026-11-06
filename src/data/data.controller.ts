import { Controller, Get, UseGuards } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/**
 * Read-only data endpoints that the standalone Reports page requires
 * (GET /booking, /vehicles, /drivers). Mirrors the main backend's
 * booking/vehicle/driver list endpoints so the analytics page gets the
 * exact same data shapes.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class DataController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('booking')
  async getBookings() {
    const bookings = await this.prisma.booking.findMany({
      orderBy: { createdAt: 'desc' },
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
          booking.overtimeCharge !== null ? Number(booking.overtimeCharge) : null,
        amountPaid:
          booking.amountPaid !== null ? Number(booking.amountPaid) : null,
      };

      // Map snake_case Prisma fields to camelCase expected by the frontend
      if ('payment_status' in booking) {
        formatted.paymentStatus = booking.payment_status;
        delete formatted.payment_status;
      }
      if ('payment_method' in booking) {
        formatted.paymentMethod = booking.payment_method;
        delete formatted.payment_method;
      }

      return formatted;
    });
  }

  @Get('vehicles')
  async getVehicles() {
    const vehicles = await this.prisma.vehicle.findMany({
      orderBy: { plateNumber: 'asc' },
    });
    return vehicles.map((vehicle) => ({
      id: vehicle.id,
      plateNumber: vehicle.plateNumber,
      model: vehicle.model,
      status: vehicle.status,
      odometer: vehicle.odometer,
      isActive: vehicle.isActive,
    }));
  }

  @Get('drivers')
  async getDrivers() {
    return this.prisma.driver.findMany({ orderBy: { name: 'asc' } });
  }
}
