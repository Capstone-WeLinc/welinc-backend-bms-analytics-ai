/**
 * Resource planning for the forecast window. Informational only: nothing here
 * changes schedules or assigns trucks and crew.
 *
 * Requirement per day = resources already assigned that day
 *                     + (expected bookings not yet assigned × crew per booking, rounded up).
 * Crew per booking comes from real records (dispatch assignments, or the crew line
 * on Wix appointments). Availability per day excludes vehicles under repair or
 * maintenance, crew on leave/off duty, and anything already assigned that day.
 */
import { round1, weekStart, type DailyForecast } from './forecast-engine';

export const MIN_KNOWN_REQUIREMENTS = 5;
export type ResourceKey = 'trucks' | 'drivers' | 'helpers';
const LABELS: Record<ResourceKey, string> = { trucks: 'Trucks', drivers: 'Drivers', helpers: 'Helpers' };
const SINGULAR: Record<ResourceKey, string> = { trucks: 'truck', drivers: 'driver', helpers: 'helper' };
const ACTIVE_ASSIGNMENT_STATES = new Set(['PENDING', 'CONFIRMED', 'RELEASING']);

export interface VehicleInput {
  id: string;
  plateNumber: string;
  status: string;
  isActive?: boolean;
  nextMaintenance?: unknown;
  expectedBackAt?: unknown;
  statusReason?: string | null;
}
export interface CrewInput { id: string; status: string }
export interface AssignmentInput { serviceDate: string; state: string; vehicleId: string | null; driverId: string | null; helperIds: string[] }
export interface RequirementBasis {
  totalBookings: number;
  knownBookings: number;
  fromAssignments: number;
  fromBookingNotes: number;
  totals: Record<ResourceKey, number>;
}

export interface ResourceSummary {
  key: ResourceKey;
  label: string;
  perBooking: number;
  peakRequired: number;
  peakDate: string;
  averageRequired: number;
  usableOnPeak: number;
  assignedOnPeak: number;
  rosterTotal: number;
  unavailableNow: number;
  shortage: number;
  shortageDays: number;
  worstShortageDate: string | null;
  utilizationPct: number | null;
}

export interface ResourcePlan {
  status: 'ok' | 'insufficient-data' | 'no-forecast';
  message: string | null;
  availabilityError: string | null;
  basis: RequirementBasis & { coveragePct: number | null; minimumKnown: number; perBooking: Record<ResourceKey, number> | null };
  resources: ResourceSummary[];
  daily: { date: string; bookings: number; assignedBookings: number; required: Record<ResourceKey, number> | null; usable: Record<ResourceKey, number> | null }[];
  weekly: { start: string; end: string; required: Record<ResourceKey, number> | null; usable: Record<ResourceKey, number> | null }[];
  unavailableVehicles: { plateNumber: string; status: string; reason: string | null; expectedBack: string | null }[];
  maintenanceInWindow: { plateNumber: string; date: string }[];
  crewUnavailable: { drivers: number; helpers: number };
  recommendations: Recommendation[];
}

/** Kind lets the UI group recommendations: most urgent (shortage) first. */
export interface Recommendation { kind: 'shortage' | 'maintenance' | 'return' | 'coverage'; text: string }

function dateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

const vehicleStatus = (status: string) => String(status ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
const crewUsable = (status: string) => ['available', 'on duty'].includes(String(status ?? 'Available').trim().toLowerCase());

/** Whether a vehicle can take a job on `date`, ignoring assignments. */
export function vehicleUsableOn(vehicle: VehicleInput, date: string, today: string): boolean {
  if (vehicle.isActive === false) return false;
  const status = vehicleStatus(vehicle.status);
  if (status === 'AVAILABLE') return dateOnly(vehicle.nextMaintenance) !== date;
  if (status === 'IN_TRANSIT') return date > today;
  const back = dateOnly(vehicle.expectedBackAt);
  // Repair / maintenance: usable only from the day after the recorded return date.
  return Boolean(back && date > back && dateOnly(vehicle.nextMaintenance) !== date);
}

const formatDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function planResources(input: {
  forecast: DailyForecast[];
  basis: RequirementBasis;
  vehicles: VehicleInput[] | null;
  drivers: CrewInput[] | null;
  helpers: CrewInput[] | null;
  assignments: AssignmentInput[] | null;
  availabilityError: string | null;
  today: string;
}): ResourcePlan {
  const { forecast, basis, today } = input;
  const coveragePct = basis.totalBookings ? (basis.knownBookings / basis.totalBookings) * 100 : null;
  const enoughBasis = basis.knownBookings >= MIN_KNOWN_REQUIREMENTS;
  const perBooking = enoughBasis
    ? { trucks: basis.totals.trucks / basis.knownBookings, drivers: basis.totals.drivers / basis.knownBookings, helpers: basis.totals.helpers / basis.knownBookings }
    : null;
  const haveAvailability = Boolean(input.vehicles && input.drivers && input.helpers && input.assignments);

  const assignmentsByDate = new Map<string, { bookings: number; trucks: Set<string>; drivers: Set<string>; helpers: Set<string> }>();
  for (const item of input.assignments ?? []) {
    if (!ACTIVE_ASSIGNMENT_STATES.has(String(item.state).toUpperCase())) continue;
    const entry = assignmentsByDate.get(item.serviceDate) ?? { bookings: 0, trucks: new Set(), drivers: new Set(), helpers: new Set() };
    entry.bookings += 1;
    if (item.vehicleId) entry.trucks.add(item.vehicleId);
    if (item.driverId) entry.drivers.add(item.driverId);
    (item.helperIds ?? []).forEach((id) => entry.helpers.add(id));
    assignmentsByDate.set(item.serviceDate, entry);
  }

  const vehicles = input.vehicles ?? [];
  const usableDrivers = (input.drivers ?? []).filter((driver) => crewUsable(driver.status));
  const usableHelpers = (input.helpers ?? []).filter((helper) => crewUsable(helper.status));

  const daily = forecast.map((day) => {
    const assigned = assignmentsByDate.get(day.date);
    const assignedBookings = assigned?.bookings ?? 0;
    const remaining = Math.max(0, day.forecast - assignedBookings);
    const required = perBooking ? {
      trucks: (assigned?.trucks.size ?? 0) + Math.ceil(remaining * perBooking.trucks - 1e-9),
      drivers: (assigned?.drivers.size ?? 0) + Math.ceil(remaining * perBooking.drivers - 1e-9),
      helpers: (assigned?.helpers.size ?? 0) + Math.ceil(remaining * perBooking.helpers - 1e-9),
    } : null;
    // Usable = every resource that can work that day; ones already assigned that day are
    // counted on the required side, so they are never treated as free capacity.
    const usable = haveAvailability ? {
      trucks: vehicles.filter((vehicle) => vehicleUsableOn(vehicle, day.date, today)).length,
      drivers: usableDrivers.length,
      helpers: usableHelpers.length,
    } : null;
    return { date: day.date, bookings: round1(day.forecast), assignedBookings, required, usable };
  });

  const resources: ResourceSummary[] = perBooking ? (['trucks', 'drivers', 'helpers'] as ResourceKey[]).map((key) => {
    const peak = daily.reduce((best, day) => (day.required![key] > best.required![key] ? day : best), daily[0]);
    const shortages = daily.map((day) => ({ date: day.date, gap: day.usable ? Math.max(0, day.required![key] - day.usable[key]) : 0 }));
    const worst = shortages.reduce((best, day) => (day.gap > best.gap ? day : best), shortages[0]);
    const roster = key === 'trucks' ? vehicles.length : key === 'drivers' ? (input.drivers ?? []).length : (input.helpers ?? []).length;
    const unavailableNow = key === 'trucks'
      ? vehicles.filter((vehicle) => !vehicleUsableOn(vehicle, today, today) && vehicleStatus(vehicle.status) !== 'IN_TRANSIT').length
      : roster - (key === 'drivers' ? usableDrivers.length : usableHelpers.length);
    return {
      key, label: LABELS[key], perBooking: Math.round(perBooking[key] * 100) / 100,
      peakRequired: peak.required![key], peakDate: peak.date,
      averageRequired: round1(daily.reduce((sum, day) => sum + day.required![key], 0) / Math.max(1, daily.length)),
      usableOnPeak: peak.usable?.[key] ?? 0,
      assignedOnPeak: (() => { const a = assignmentsByDate.get(peak.date); return key === 'trucks' ? a?.trucks.size ?? 0 : key === 'drivers' ? a?.drivers.size ?? 0 : a?.helpers.size ?? 0; })(),
      rosterTotal: roster, unavailableNow,
      shortage: haveAvailability ? worst.gap : 0,
      shortageDays: haveAvailability ? shortages.filter((day) => day.gap > 0).length : 0,
      worstShortageDate: haveAvailability && worst.gap > 0 ? worst.date : null,
      utilizationPct: peak.usable && peak.usable[key] > 0 ? Math.round((peak.required![key] / peak.usable[key]) * 100) : null,
    };
  }) : [];

  const weeklyMap = new Map<string, typeof daily>();
  daily.forEach((day) => { const key = weekStart(day.date); weeklyMap.set(key, [...(weeklyMap.get(key) ?? []), day]); });
  const weekly = [...weeklyMap.values()].map((days) => ({
    start: days[0].date, end: days[days.length - 1].date,
    required: perBooking ? { trucks: Math.max(...days.map((d) => d.required!.trucks)), drivers: Math.max(...days.map((d) => d.required!.drivers)), helpers: Math.max(...days.map((d) => d.required!.helpers)) } : null,
    usable: haveAvailability ? { trucks: Math.min(...days.map((d) => d.usable!.trucks)), drivers: Math.min(...days.map((d) => d.usable!.drivers)), helpers: Math.min(...days.map((d) => d.usable!.helpers)) } : null,
  }));

  const windowStart = forecast[0]?.date ?? today;
  const windowEnd = forecast[forecast.length - 1]?.date ?? today;
  const unavailableVehicles = vehicles
    .filter((vehicle) => !['AVAILABLE', 'IN_TRANSIT'].includes(vehicleStatus(vehicle.status)))
    .map((vehicle) => ({ plateNumber: vehicle.plateNumber, status: vehicleStatus(vehicle.status).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), reason: vehicle.statusReason ?? null, expectedBack: dateOnly(vehicle.expectedBackAt) }));
  const maintenanceInWindow = vehicles
    .map((vehicle) => ({ plateNumber: vehicle.plateNumber, date: dateOnly(vehicle.nextMaintenance) }))
    .filter((item): item is { plateNumber: string; date: string } => Boolean(item.date && item.date >= windowStart && item.date <= windowEnd));

  const recommendations: Recommendation[] = [];
  if (perBooking && haveAvailability) {
    resources.filter((r) => r.shortage > 0).forEach((r) => recommendations.push({ kind: 'shortage', text:
      `Arrange ${r.shortage} more ${r.shortage === 1 ? SINGULAR[r.key] : r.label.toLowerCase()} for ${formatDate(r.worstShortageDate!)}: up to ${r.peakRequired} may be needed on the busiest day, while ${r.usableOnPeak} are usable.${r.shortageDays > 1 ? ` A shortage is expected on ${r.shortageDays} days in this period.` : ''}`,
    }));
    const peakTrucks = resources.find((r) => r.key === 'trucks');
    maintenanceInWindow.forEach((item) => recommendations.push({ kind: 'maintenance', text: `${item.plateNumber} is due for maintenance on ${formatDate(item.date)}${peakTrucks && item.date === peakTrucks.peakDate ? ', the busiest day' : ''}; confirm the schedule before taking bookings for that day.` }));
    unavailableVehicles.filter((v) => v.expectedBack).forEach((v) => recommendations.push({ kind: 'return', text: `${v.plateNumber} (${v.status}) is expected back on ${formatDate(v.expectedBack!)}; follow up so it returns before the peak.` }));
    if (!resources.some((r) => r.shortage > 0)) {
      const trucks = resources.find((r) => r.key === 'trucks')!;
      recommendations.push({ kind: 'coverage', text: `Current fleet and crew cover the expected peak: ${trucks.peakRequired} trucks needed on ${formatDate(trucks.peakDate)} with ${trucks.usableOnPeak} usable.` });
    }
  }

  let status: ResourcePlan['status'] = 'ok';
  let message: string | null = null;
  if (!forecast.length) { status = 'no-forecast'; message = 'There is no forecast to plan resources for.'; }
  else if (!perBooking) {
    status = 'insufficient-data';
    message = `Only ${basis.knownBookings} booking${basis.knownBookings === 1 ? '' : 's'} record how many trucks, drivers and helpers were used; at least ${MIN_KNOWN_REQUIREMENTS} are needed to estimate requirements.`;
  }

  return {
    status, message, availabilityError: input.availabilityError,
    basis: { ...basis, coveragePct, minimumKnown: MIN_KNOWN_REQUIREMENTS, perBooking },
    resources, daily, weekly, unavailableVehicles, maintenanceInWindow,
    crewUnavailable: { drivers: (input.drivers ?? []).length - usableDrivers.length, helpers: (input.helpers ?? []).length - usableHelpers.length },
    recommendations,
  };
}
