import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import {
  INCLUDE_CANCELLED_IN_TOTAL, computeOperationalReport, computeResourcesSnapshot, crewDisplayStatus, defaultRange,
  manilaDay, matchesService, monthsInRange, vehicleDisplayStatus,
  type AssignmentInput, type BookingInput, type JobOrderInput, type PostServiceInput, type VehicleInput,
} from '../src/reports/operational/operational-report';
import { BmsAdminGuard } from '../src/auth/guards/bms-admin.guard';

const RANGE = { from: '2025-11-11', to: '2026-11-10' };
const vehicles: VehicleInput[] = [
  { id: 'v1', plateNumber: 'ABC 1234', alias: 'Truck 1' },
  { id: 'v2', plateNumber: 'XYZ 9876', alias: null },
];

function booking(id: string, date: string, extra: Partial<BookingInput> = {}): BookingInput {
  return { id, bookingId: `BK-${id}`, bookingNo: `NO-${id}`, service: 'Lipat Bahay', date, status: 'For Plotting', updatedAt: `${date}T02:00:00Z`, ...extra };
}

function run(input: Partial<{ bookings: BookingInput[]; assignments: AssignmentInput[]; jobOrders: JobOrderInput[]; postService: PostServiceInput[] }>, filters: Partial<typeof RANGE & { serviceId: string; vehicleId: string }> = {}) {
  return computeOperationalReport(
    { bookings: [], assignments: [], jobOrders: [], postService: [], vehicles, ...input },
    { ...RANGE, ...filters },
  );
}

test('default range is the last 12 months ending today in Manila', () => {
  // 2026-11-10 20:00 UTC is already 2026-11-11 in Manila.
  assert.deepEqual(defaultRange(new Date('2026-11-10T03:00:00Z')), { from: '2025-11-11', to: '2026-11-10' });
  assert.deepEqual(defaultRange(new Date('2026-11-10T20:00:00Z')), { from: '2025-11-12', to: '2026-11-11' });
});

test('monthly axis is continuous: 13 months for Nov 2025 to Nov 2026, zeros included', () => {
  assert.equal(monthsInRange('2025-11-11', '2026-11-10').length, 13);
  assert.deepEqual(monthsInRange('2025-12-05', '2026-02-01'), ['2025-12', '2026-01', '2026-02']);
  const report = run({ bookings: [booking('c1', '2026-11-03', { status: 'Cancelled', updatedAt: '2026-11-04T01:00:00Z' })] });
  assert.equal(report.monthly.length, 13);
  assert.equal(report.monthly[0].month, '2025-11');
  assert.equal(report.monthly[12].month, '2026-11');
  assert.ok(report.monthly.slice(0, 12).every((month) => month.completed === 0 && month.cancelled === 0));
  assert.deepEqual(report.monthly[12], { month: '2026-11', completed: 0, cancelled: 1 });
});

test('Total bookings counts bookings dated in the range and leaves out cancelled bookings', () => {
  const report = run({
    bookings: [
      booking('a', '2025-11-11'), booking('b', '2026-11-10'), booking('c', '2026-05-01', { status: 'Cancelled' }),
      booking('early', '2025-11-10'), booking('late', '2026-11-11'),
    ],
  });
  assert.equal(INCLUDE_CANCELLED_IN_TOTAL, false);
  assert.equal(report.totals.bookings, 2);
  assert.equal(report.totals.unassigned, 2);
  assert.equal(report.params.includesCancelledInTotal, false);
});

test('Bookings with a vehicle needs a CONFIRMED assignment with a vehicle; unassigned is the rest', () => {
  const report = run({
    bookings: [booking('a', '2026-01-01'), booking('b', '2026-01-02'), booking('c', '2026-01-03'), booking('d', '2026-01-04')],
    assignments: [
      { bookingUuid: 'a', vehicleId: 'v1', state: 'CONFIRMED' },
      { bookingUuid: 'b', vehicleId: 'v1', state: 'PENDING' },
      { bookingUuid: 'c', vehicleId: null, state: 'CONFIRMED' },
    ],
  });
  assert.equal(report.totals.withVehicle, 1);
  assert.equal(report.totals.unassigned, 3);
  assert.equal(report.totals.withVehicle + report.totals.unassigned, report.totals.bookings);
});

test('Completed and cancelled count by the day the job closed, not the booking date', () => {
  const report = run({
    bookings: [
      // Booked before the range, completed inside it: counted.
      booking('done', '2025-10-30', { status: 'Completed', updatedAt: '2026-03-02T00:00:00Z' }),
      // Completion date comes from post-service finalizedAt when present.
      booking('final', '2026-02-01', { status: 'Completed', updatedAt: '2026-12-01T00:00:00Z' }),
      booking('gone', '2026-06-01', { status: 'Cancelled', updatedAt: '2026-06-02T00:00:00Z' }),
      booking('later', '2026-06-01', { status: 'Cancelled', updatedAt: '2026-11-20T00:00:00Z' }),
      booking('open', '2026-06-01', { status: 'Assigned' }),
    ],
    postService: [{ bookingId: 'BK-final', finalizedAt: '2026-02-03T05:00:00Z' }],
  });
  assert.equal(report.totals.completed, 2);
  assert.equal(report.totals.cancelled, 1);
  const byMonth = Object.fromEntries(report.monthly.map((month) => [month.month, month]));
  assert.equal(byMonth['2026-03'].completed, 1);
  assert.equal(byMonth['2026-02'].completed, 1);
  assert.equal(byMonth['2026-06'].cancelled, 1);
  const closed = report.monthly.reduce((sum, month) => sum + month.completed + month.cancelled, 0);
  assert.equal(closed, report.totals.completed + report.totals.cancelled);
});

test('months and range edges use Asia/Manila days', () => {
  assert.equal(manilaDay('2026-10-31T16:30:00Z'), '2026-11-01');
  assert.equal(manilaDay('2026-10-31T15:59:00Z'), '2026-10-31');
  const report = run({
    bookings: [
      // 00:30 on Nov 1 in Manila: November, even though it is still Oct 31 in UTC.
      booking('nov', '2026-10-20', { status: 'Cancelled', updatedAt: '2026-10-31T16:30:00Z' }),
      // 00:30 on Nov 11 in Manila: after the range end, so not counted.
      booking('out', '2026-10-20', { status: 'Cancelled', updatedAt: '2026-11-10T16:30:00Z' }),
      // 23:30 on Nov 10 in Manila: the last day of the range, counted.
      booking('edge', '2026-10-20', { status: 'Completed', updatedAt: '2026-11-10T15:30:00Z' }),
    ],
  });
  const nov = report.monthly.find((month) => month.month === '2026-11')!;
  const oct = report.monthly.find((month) => month.month === '2026-10')!;
  assert.deepEqual([nov.cancelled, nov.completed, oct.cancelled], [1, 1, 0]);
  assert.equal(report.totals.cancelled, 1);
});

test('Job orders count active orders issued in the range; pending ones are not yet distributed', () => {
  const report = run({
    bookings: [booking('a', '2026-01-01'), booking('b', '2026-01-02'), booking('c', '2026-01-03')],
    jobOrders: [
      { bookingUuid: 'a', status: 'Distributed', state: 'ACTIVE', generatedAt: '2026-01-01T01:00:00Z' },
      { bookingUuid: 'b', status: 'Pending', state: 'ACTIVE', generatedAt: '2026-01-02T01:00:00Z' },
      { bookingUuid: 'c', status: 'Pending', state: 'SUPERSEDED', generatedAt: '2026-01-03T01:00:00Z' },
      { bookingUuid: 'x', status: 'Distributed', state: 'ACTIVE', generatedAt: '2025-01-01T01:00:00Z' },
    ],
  });
  assert.equal(report.totals.jobOrders, 2);
  assert.equal(report.totals.jobOrdersNotDistributed, 1);
});

test('Services and Vehicle filters apply to totals, closed jobs, job orders and jobs per vehicle', () => {
  const input = {
    bookings: [
      booking('a', '2026-01-01', { service: 'Office Pull out' }),
      booking('b', '2026-01-02', { service: 'Lipat Bahay' }),
      booking('c', '2026-01-03', { service: 'Office Pull out', status: 'Completed', updatedAt: '2026-01-04T00:00:00Z' }),
    ],
    assignments: [
      { bookingUuid: 'a', vehicleId: 'v1', state: 'CONFIRMED' },
      { bookingUuid: 'b', vehicleId: 'v2', state: 'CONFIRMED' },
      { bookingUuid: 'c', vehicleId: 'v1', state: 'CONFIRMED' },
    ],
    jobOrders: [
      { bookingUuid: 'a', status: 'Pending', state: 'ACTIVE', generatedAt: '2026-01-01T00:00:00Z' },
      { bookingUuid: 'b', status: 'Pending', state: 'ACTIVE', generatedAt: '2026-01-02T00:00:00Z' },
    ],
  };
  const byService = run(input, { serviceId: 'Office Pull Out' });
  assert.equal(byService.totals.bookings, 2);
  assert.equal(byService.totals.completed, 1);
  assert.equal(byService.totals.jobOrders, 1);
  assert.deepEqual(byService.jobsPerVehicle.map((row) => [row.vehicleId, row.jobs]), [['v1', 2]]);

  const byVehicle = run(input, { vehicleId: 'v2' });
  assert.equal(byVehicle.totals.bookings, 1);
  assert.equal(byVehicle.totals.withVehicle, 1);
  assert.equal(byVehicle.totals.completed, 0);
  assert.equal(byVehicle.totals.jobOrders, 1);
  assert.deepEqual(byVehicle.jobsPerVehicle.map((row) => row.plate), ['XYZ 9876']);

  assert.ok(matchesService({ id: '1', service: 'Unit to unit transfer' }, 'Unit to Unit Transfer'));
  assert.ok(!matchesService({ id: '1', service: 'Lipat Bahay' }, 'Corporate Delivery'));
});

test('Jobs per vehicle ranks vehicles by confirmed jobs, busiest first, with plate and alias', () => {
  const report = run({
    bookings: [booking('a', '2026-01-01'), booking('b', '2026-01-02'), booking('c', '2026-01-03')],
    assignments: [
      { bookingUuid: 'a', vehicleId: 'v2', state: 'CONFIRMED' },
      { bookingUuid: 'b', vehicleId: 'v1', state: 'CONFIRMED' },
      { bookingUuid: 'c', vehicleId: 'v1', state: 'CONFIRMED' },
    ],
  });
  assert.deepEqual(report.jobsPerVehicle, [
    { vehicleId: 'v1', plate: 'ABC 1234', alias: 'Truck 1', jobs: 2 },
    { vehicleId: 'v2', plate: 'XYZ 9876', alias: null, jobs: 1 },
  ]);
});

test('empty data gives zeros and an empty vehicle list', () => {
  const report = run({});
  assert.deepEqual(report.totals, { bookings: 0, withVehicle: 0, unassigned: 0, completed: 0, cancelled: 0, jobOrders: 0, jobOrdersNotDistributed: 0 });
  assert.equal(report.monthly.length, 13);
  assert.deepEqual(report.jobsPerVehicle, []);
});

test('resources snapshot matches the Vehicle & Team Availability statuses', () => {
  assert.equal(vehicleDisplayStatus({ id: '1', status: 'UNDER_MAINTENANCE' }), 'underMaintenance');
  assert.equal(vehicleDisplayStatus({ id: '1', status: 'Under Repair', isAssigned: true }), 'underRepair');
  assert.equal(vehicleDisplayStatus({ id: '1', status: 'IN_TRANSIT' }), 'assigned');
  assert.equal(vehicleDisplayStatus({ id: '1', status: 'Assigned', isAssigned: true }), 'assigned');
  assert.equal(vehicleDisplayStatus({ id: '1', status: 'AVAILABLE' }), 'available');
  assert.equal(crewDisplayStatus({ status: 'On Leave' }), 'onLeave');
  assert.equal(crewDisplayStatus({ status: 'ON_LEAVE' }), 'onLeave');
  assert.equal(crewDisplayStatus({ crewStatus: 'Available' }), 'available');
  assert.equal(crewDisplayStatus({ status: 'Off Duty' }), 'available');
  assert.equal(crewDisplayStatus({ status: 'On Duty' }), 'onDuty');

  const snapshot = computeResourcesSnapshot({
    vehicles: [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, status: 'AVAILABLE' })),
      { id: 'm', status: 'UNDER_MAINTENANCE' }, { id: 'r', status: 'UNDER_REPAIR' },
    ],
    drivers: Array.from({ length: 13 }, () => ({ status: 'Available' })),
    helpers: [...Array.from({ length: 19 }, () => ({ status: 'Available' })), { status: 'On Leave' }],
  });
  assert.deepEqual(snapshot.vehicles, { total: 12, available: 10, assigned: 0, underMaintenance: 1, underRepair: 1 });
  assert.deepEqual(snapshot.drivers, { onRoster: 13, available: 13, onDuty: 0, onLeave: 0 });
  assert.deepEqual(snapshot.helpers, { onRoster: 20, available: 19, onDuty: 0, onLeave: 1 });
  // Display-only sample vehicles never count: their statuses are not real.
  const withSamples = computeResourcesSnapshot({
    vehicles: [{ id: 'real', status: 'AVAILABLE' }, { id: 's1', status: 'Assigned', isAssigned: true, isSample: true }, { id: 's2', status: 'Under Maintenance', isSample: true }],
    drivers: [], helpers: [],
  });
  assert.deepEqual(withSamples.vehicles, { total: 1, available: 1, assigned: 0, underMaintenance: 0, underRepair: 0 });
  // It takes no dates or filters at all, so the report range cannot change it.
  assert.equal(computeResourcesSnapshot.length, 1);
});

test('the operational endpoints are Admin only', () => {
  const guard = new BmsAdminGuard();
  const context = (roles: { role: string; system: string }[]) => ({ switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }) }) as never;
  assert.equal(guard.canActivate(context([{ role: 'ADMIN', system: 'BMS' }])), true);
  assert.throws(() => guard.canActivate(context([{ role: 'OPERATIONS', system: 'BMS' }])), ForbiddenException);
  assert.throws(() => guard.canActivate(context([{ role: 'ADMIN', system: 'WELINC' }])), ForbiddenException);
});
