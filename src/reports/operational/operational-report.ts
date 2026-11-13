/**
 * Operational Report calculations. Pure functions only: the service loads the
 * records from their owning services and passes them in, so every definition
 * below can be tested without a database.
 *
 * DEFINITIONS (one rule per figure, used everywhere on the page and in exports)
 * - Dates are Asia/Manila calendar days. A range is inclusive on both ends.
 * - A booking is "in the period" when its booking date (`date`) falls in the range
 *   and it matches the Services and Vehicle filters.
 * - Total bookings = bookings in the period, excluding cancelled bookings (they are
 *   reported separately under Completed services as "{n} cancelled"). The same
 *   population is the denominator for "Bookings with a vehicle".
 * - Bookings with a vehicle = bookings in the period with a CONFIRMED dispatch
 *   assignment that has a vehicle. Unassigned = total - with a vehicle.
 * - Completed = bookings with status Completed whose completion date (post-service
 *   finalizedAt, else the booking's last update; completed bookings cannot change)
 *   falls in the range. Cancelled = bookings with status Cancelled whose last update
 *   (cancelled bookings cannot change) falls in the range. Closed = completed + cancelled.
 *   The monthly chart groups the same jobs by that close month.
 * - Job orders = active job orders whose generatedAt falls in the range. Not yet
 *   distributed = those still Pending.
 * - Jobs per vehicle = CONFIRMED assignments with a vehicle for bookings in the period.
 * - The Vehicle filter matches the vehicle on the booking's CONFIRMED assignment.
 */

// Decided: cancelled bookings are not part of Total bookings. This one flag governs
// Total bookings, Bookings with a vehicle and Unassigned together.
export const INCLUDE_CANCELLED_IN_TOTAL = false;

export const MANILA_TZ = 'Asia/Manila';

export interface BookingInput {
  id: string;
  bookingId?: string | null;
  bookingNo?: string | null;
  service?: string | null;
  serviceType?: string | null;
  date?: string | null;
  status?: string | null;
  updatedAt?: string | Date | null;
}

export interface AssignmentInput {
  bookingUuid: string;
  vehicleId?: string | null;
  state?: string | null;
}

export interface JobOrderInput {
  bookingUuid?: string | null;
  status?: string | null;
  state?: string | null;
  generatedAt?: string | Date | null;
}

export interface PostServiceInput {
  bookingId?: string | null;
  bookingNo?: string | null;
  finalizedAt?: string | Date | null;
}

export interface VehicleInput {
  id: string;
  plateNumber?: string | null;
  plate?: string | null;
  alias?: string | null;
  status?: string | null;
  isAssigned?: boolean | null;
  /** Display-only sample row from the availability page; never part of the real fleet. */
  isSample?: boolean | null;
}

export interface CrewInput {
  id?: string;
  status?: string | null;
  crewStatus?: string | null;
}

export interface OperationalFilters {
  from: string;
  to: string;
  serviceId?: string | null;
  vehicleId?: string | null;
}

export interface OperationalReport {
  params: { from: string; to: string; serviceId: string; vehicleId: string; timezone: string; includesCancelledInTotal: boolean };
  totals: {
    bookings: number;
    withVehicle: number;
    unassigned: number;
    completed: number;
    cancelled: number;
    jobOrders: number;
    jobOrdersNotDistributed: number;
  };
  monthly: { month: string; completed: number; cancelled: number }[];
  jobsPerVehicle: { vehicleId: string; plate: string; alias: string | null; jobs: number }[];
}

export interface ResourcesSnapshot {
  vehicles: { total: number; available: number; assigned: number; underMaintenance: number; underRepair: number };
  drivers: { onRoster: number; available: number; onDuty: number; onLeave: number };
  helpers: { onRoster: number; available: number; onDuty: number; onLeave: number };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The Manila calendar day of a timestamp, as YYYY-MM-DD. Plain dates pass through unchanged. */
export function manilaDay(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && DATE_RE.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-CA', { timeZone: MANILA_TZ });
}

/** A booking date is a calendar day already; only its first 10 characters matter. */
function bookingDay(value: string | null | undefined): string | null {
  const day = String(value ?? '').slice(0, 10);
  return DATE_RE.test(day) ? day : null;
}

/** Every month from the month of `from` to the month of `to`, inclusive: ["2025-11", ..., "2026-11"]. */
export function monthsInRange(from: string, to: string): string[] {
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  const months: string[] = [];
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > endKey) break;
    months.push(key);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

/** The default range: the 12 months ending today in Manila (today and the 364 days before it). */
export function defaultRange(now = new Date()): { from: string; to: string } {
  const to = manilaDay(now)!;
  const start = new Date(Date.parse(`${to}T00:00:00Z`) - 364 * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to };
}

const normalizeService = (value: string | null | undefined) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** Matches booking service names such as "Office Pull out" and "Office Pull Out" to one filter value. */
export function matchesService(booking: BookingInput, serviceId: string | null | undefined): boolean {
  if (!serviceId || serviceId === 'All') return true;
  const wanted = normalizeService(serviceId);
  return [booking.serviceType, booking.service].some((value) => {
    const key = normalizeService(value);
    return Boolean(key) && (key === wanted || key.includes(wanted));
  });
}

const statusIs = (status: string | null | undefined, expected: string) => String(status ?? '').trim().toLowerCase() === expected;
const isCancelled = (status: string | null | undefined) => /cancel/i.test(String(status ?? ''));
const isCompleted = (status: string | null | undefined) => statusIs(status, 'completed');
const inRange = (day: string | null, from: string, to: string) => day !== null && day >= from && day <= to;

export function computeOperationalReport(
  input: { bookings: BookingInput[]; assignments: AssignmentInput[]; jobOrders: JobOrderInput[]; postService: PostServiceInput[]; vehicles: VehicleInput[] },
  filters: OperationalFilters,
): OperationalReport {
  const { from, to } = filters;
  const serviceId = filters.serviceId && filters.serviceId !== 'All' ? filters.serviceId : null;
  const vehicleId = filters.vehicleId && filters.vehicleId !== 'All' ? filters.vehicleId : null;

  // One confirmed vehicle per booking (bookingUuid is unique per assignment).
  const vehicleByBooking = new Map<string, string>();
  for (const assignment of input.assignments) {
    if (statusIs(assignment.state, 'confirmed') && assignment.vehicleId) vehicleByBooking.set(assignment.bookingUuid, assignment.vehicleId);
  }
  const matchesFilters = (booking: BookingInput) => matchesService(booking, serviceId)
    && (!vehicleId || vehicleByBooking.get(booking.id) === vehicleId);

  // Population for Total bookings, Bookings with a vehicle and Jobs per vehicle.
  const population = input.bookings.filter((booking) => inRange(bookingDay(booking.date), from, to)
    && matchesFilters(booking)
    && (INCLUDE_CANCELLED_IN_TOTAL || !isCancelled(booking.status)));
  const withVehicle = population.filter((booking) => vehicleByBooking.has(booking.id)).length;

  // Closed jobs, by the Manila day they closed.
  const finalizedByReference = new Map<string, string | Date>();
  for (const record of input.postService) {
    if (!record.finalizedAt) continue;
    for (const key of [record.bookingId, record.bookingNo]) if (key) finalizedByReference.set(key, record.finalizedAt);
  }
  const months = monthsInRange(from, to);
  const monthly = new Map(months.map((month) => [month, { month, completed: 0, cancelled: 0 }]));
  let completed = 0;
  let cancelled = 0;
  for (const booking of input.bookings) {
    const done = isCompleted(booking.status);
    const dropped = !done && isCancelled(booking.status);
    if ((!done && !dropped) || !matchesFilters(booking)) continue;
    const finalizedAt = done
      ? finalizedByReference.get(booking.bookingId ?? '') ?? finalizedByReference.get(booking.bookingNo ?? '') ?? booking.updatedAt
      : booking.updatedAt;
    const closedOn = manilaDay(finalizedAt ?? null);
    if (!inRange(closedOn, from, to)) continue;
    const bucket = monthly.get(closedOn!.slice(0, 7));
    if (done) { completed += 1; if (bucket) bucket.completed += 1; } else { cancelled += 1; if (bucket) bucket.cancelled += 1; }
  }

  // Job orders issued in the period.
  const bookingById = new Map(input.bookings.map((booking) => [booking.id, booking]));
  const issued = input.jobOrders.filter((jobOrder) => {
    if (statusIs(jobOrder.state, 'superseded')) return false;
    if (!['pending', 'distributed'].includes(String(jobOrder.status ?? '').trim().toLowerCase())) return false;
    if (!inRange(manilaDay(jobOrder.generatedAt ?? null), from, to)) return false;
    if (!serviceId && !vehicleId) return true;
    const booking = jobOrder.bookingUuid ? bookingById.get(jobOrder.bookingUuid) : undefined;
    return Boolean(booking && matchesFilters(booking));
  });

  // Confirmed assignments per vehicle, busiest first.
  const vehicleById = new Map(input.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const jobs = new Map<string, number>();
  for (const booking of population) {
    const id = vehicleByBooking.get(booking.id);
    if (id) jobs.set(id, (jobs.get(id) ?? 0) + 1);
  }
  const jobsPerVehicle = [...jobs.entries()].map(([id, count]) => {
    const vehicle = vehicleById.get(id);
    return { vehicleId: id, plate: vehicle?.plateNumber || vehicle?.plate || 'Unlisted vehicle', alias: vehicle?.alias || null, jobs: count };
  }).sort((a, b) => b.jobs - a.jobs || a.plate.localeCompare(b.plate));

  return {
    params: { from, to, serviceId: serviceId ?? 'All', vehicleId: vehicleId ?? 'All', timezone: MANILA_TZ, includesCancelledInTotal: INCLUDE_CANCELLED_IN_TOTAL },
    totals: {
      bookings: population.length,
      withVehicle,
      unassigned: population.length - withVehicle,
      completed,
      cancelled,
      jobOrders: issued.length,
      jobOrdersNotDistributed: issued.filter((jobOrder) => statusIs(jobOrder.status, 'pending')).length,
    },
    monthly: months.map((month) => monthly.get(month)!),
    jobsPerVehicle,
  };
}

/**
 * The status shown on the Vehicle & Team Availability page (getDisplayVehicleStatus):
 * maintenance and repair win; In Transit or booked today is Assigned; anything else is Available.
 */
export function vehicleDisplayStatus(vehicle: VehicleInput): 'available' | 'assigned' | 'underMaintenance' | 'underRepair' {
  const status = String(vehicle.status ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (status === 'under maintenance') return 'underMaintenance';
  if (status === 'under repair') return 'underRepair';
  if (status === 'in transit') return 'assigned';
  return vehicle.isAssigned ? 'assigned' : 'available';
}

/**
 * Crew status exactly as the Vehicle & Team Availability badges show it: Available, On Duty
 * or On Leave. That page shows "Off Duty" as Available. The dispatch service accepts no other
 * value, so anything unexpected is counted as On Leave (not available to work).
 */
export function crewDisplayStatus(member: CrewInput): 'available' | 'onDuty' | 'onLeave' {
  const status = String(member.status || member.crewStatus || 'Available').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (status === 'available' || status === 'off duty') return 'available';
  if (status === 'on duty') return 'onDuty';
  return 'onLeave';
}

/** Today's fleet and roster. It takes no dates or filters, so the report range cannot affect it. */
export function computeResourcesSnapshot(input: { vehicles: VehicleInput[]; drivers: CrewInput[]; helpers: CrewInput[] }): ResourcesSnapshot {
  const fleet = input.vehicles.filter((vehicle) => vehicle.isSample !== true);
  const vehicles = { total: fleet.length, available: 0, assigned: 0, underMaintenance: 0, underRepair: 0 };
  for (const vehicle of fleet) vehicles[vehicleDisplayStatus(vehicle)] += 1;
  const crew = (members: CrewInput[]) => {
    const counts = { onRoster: members.length, available: 0, onDuty: 0, onLeave: 0 };
    for (const member of members) counts[crewDisplayStatus(member)] += 1;
    return counts;
  };
  return { vehicles, drivers: crew(input.drivers), helpers: crew(input.helpers) };
}
