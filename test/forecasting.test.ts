import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backtest, crewRequirement, dailyCounts, demandLevel, errorMetrics, fitModel, forecastWindow, mapServiceType, peakWeek, predict,
} from '../src/reports/forecasting/forecast-engine';
import { planResources, vehicleUsableOn } from '../src/reports/forecasting/resource-planner';
import { allowedNumbers, groundItems, isGrounded } from '../src/reports/forecasting/insights';

test('forecast window: next month and N-day horizons', () => {
  assert.deepEqual(forecastWindow('2026-11-09', 'nextMonth'), { start: '2026-12-01', end: '2026-12-31', days: 31 });
  assert.deepEqual(forecastWindow('2026-12-15', 'nextMonth'), { start: '2027-01-01', end: '2027-01-31', days: 31 });
  assert.deepEqual(forecastWindow('2026-11-09', '7days'), { start: '2026-11-10', end: '2026-11-16', days: 7 });
});

test('MAE and MAPE match hand calculations; MAPE skips zero actuals', () => {
  const metrics = errorMetrics([{ actual: 4, predicted: 2 }, { actual: 2, predicted: 3 }, { actual: 0, predicted: 1 }]);
  assert.equal(metrics.mae, (2 + 1 + 1) / 3);
  assert.equal(metrics.mape, ((2 / 4 + 1 / 2) / 2) * 100); // 50%
  assert.equal(metrics.mapeDaysUsed, 2);
  assert.equal(metrics.zeroActualDays, 1);
  assert.equal(errorMetrics([{ actual: 0, predicted: 1 }]).mape, null);
  assert.equal(errorMetrics([]).mae, null);
});

test('short history falls back to the historical daily average', () => {
  const history = dailyCounts(['2026-11-01', '2026-11-01', '2026-11-03'], '2026-11-01', '2026-11-10');
  const model = fitModel(history);
  assert.equal(model.method, 'historical-average');
  assert.equal(model.overallRate, 0.3);
  assert.ok(model.weekdayRates.every((rate) => rate === 0.3));
  assert.equal(fitModel([]).method, 'none');
});

test('weighted weekday model reproduces a steady weekly pattern exactly', () => {
  // Two bookings every Monday, none otherwise, for six weeks.
  const dates: string[] = [];
  for (let week = 0; week < 6; week += 1) {
    const monday = new Date(Date.UTC(2026, 9, 5 + week * 7)).toISOString().slice(0, 10);
    dates.push(monday, monday);
  }
  const history = dailyCounts(dates, '2026-10-04', '2026-11-14');
  const model = fitModel(history);
  assert.equal(model.method, 'weighted-weekday');
  assert.ok(Math.abs(model.weekdayRates[1] - 2) < 1e-9);
  assert.equal(model.weekdayRates[3], 0);
  const forecast = predict(model, '2026-11-16', '2026-11-22');
  assert.equal(forecast.reduce((sum, day) => sum + day.forecast, 0), 2);
  const result = backtest(history);
  assert.equal(result.available, true);
  assert.equal(result.mae, 0);
  assert.equal(result.mape, 0);
});

test('backtest reports insufficient data instead of a score, and uses 7 test days for short history', () => {
  const result = backtest(dailyCounts(['2026-11-01'], '2026-11-01', '2026-11-20'));
  assert.equal(result.available, false);
  assert.equal(result.mae, null);
  assert.match(result.reason!, /21 days/);
  const short = backtest(dailyCounts(['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22'], '2026-10-29', '2026-11-22'));
  assert.equal(short.available, true);
  assert.equal(short.testDays, 7);
  assert.equal(short.trainingDays, 18);
});

test('peak week and demand level', () => {
  const daily = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08', '2026-12-09']
    .map((date, i) => ({ date, forecast: i >= 2 ? 3 : 1 }));
  assert.deepEqual(peakWeek(daily), { start: '2026-12-03', end: '2026-12-09', bookings: 21, distinct: true });
  const flat = Array.from({ length: 14 }, (_, i) => ({ date: `2026-12-${String(i + 1).padStart(2, '0')}`, forecast: i % 7 === 2 ? 5 : 1 }));
  assert.equal(peakWeek(flat)!.distinct, false);
  assert.equal(demandLevel(1.2, 1)!.level, 'High');
  assert.equal(demandLevel(1, 1)!.level, 'Moderate');
  assert.equal(demandLevel(0.8, 1)!.level, 'Low');
  assert.equal(demandLevel(1, 0), null);
});

test('service mapping uses only what the record states', () => {
  assert.equal(mapServiceType('Office Pull Out', 'Office Pull Out'), 'Office Pull Out');
  assert.equal(mapServiceType('APPOINTMENT', 'Unit to Unit Transfer'), 'Unit to Unit Transfer');
  assert.equal(mapServiceType(null, 'Office Pull out'), 'Office Pull Out');
  assert.equal(mapServiceType('APPOINTMENT', 'NC: 6W 14 FT. W/ Lifter (2 Helpers)'), null);
  assert.equal(mapServiceType('APPOINTMENT', 'Motorized Helper'), null);
});

test('crew requirement comes from assignments first, then the booking crew line', () => {
  assert.deepEqual(crewRequirement('Welinc service resource: 14FT: 1 DRIVER + 2 HELPERS', null), { trucks: 1, drivers: 1, helpers: 2, source: 'booking-notes' });
  assert.deepEqual(crewRequirement('Welinc service resource: L300: 1 DRIVER + 1 HELPER (PM)', null), { trucks: 1, drivers: 1, helpers: 1, source: 'booking-notes' });
  assert.deepEqual(crewRequirement('Welinc service resource: 14FT: 1 DRIVER + 2 HELPERS', { vehicleId: 'v', driverId: 'd', helperIds: ['a', 'b', 'c'] }), { trucks: 1, drivers: 1, helpers: 3, source: 'assignment' });
  assert.equal(crewRequirement('Welinc service resource: Welinc: Additional Services', null), null);
  assert.equal(crewRequirement(null, { vehicleId: null, driverId: null, helperIds: [] }), null);
});

test('vehicle availability excludes repair, maintenance days and in-transit today', () => {
  const today = '2026-11-09';
  assert.equal(vehicleUsableOn({ id: '1', plateNumber: 'A', status: 'AVAILABLE' }, '2026-12-01', today), true);
  assert.equal(vehicleUsableOn({ id: '1', plateNumber: 'A', status: 'AVAILABLE', nextMaintenance: '2026-12-01' }, '2026-12-01', today), false);
  assert.equal(vehicleUsableOn({ id: '1', plateNumber: 'A', status: 'UNDER_REPAIR' }, '2026-12-01', today), false);
  assert.equal(vehicleUsableOn({ id: '1', plateNumber: 'A', status: 'UNDER_REPAIR', expectedBackAt: '2026-11-20' }, '2026-12-01', today), true);
  assert.equal(vehicleUsableOn({ id: '1', plateNumber: 'A', status: 'IN_TRANSIT' }, today, today), false);
  assert.equal(vehicleUsableOn({ id: '1', plateNumber: 'A', status: 'AVAILABLE', isActive: false }, '2026-12-01', today), false);
});

test('resource plan: assigned resources are never counted as free, shortages are detected', () => {
  const plan = planResources({
    forecast: [{ date: '2026-12-01', forecast: 3 }, { date: '2026-12-02', forecast: 1 }],
    basis: { totalBookings: 10, knownBookings: 10, fromAssignments: 0, fromBookingNotes: 10, totals: { trucks: 10, drivers: 10, helpers: 15 } },
    vehicles: [{ id: 'v1', plateNumber: 'A', status: 'AVAILABLE' }, { id: 'v2', plateNumber: 'B', status: 'AVAILABLE' }, { id: 'v3', plateNumber: 'C', status: 'UNDER_REPAIR' }],
    drivers: [{ id: 'd1', status: 'Available' }, { id: 'd2', status: 'On Leave' }, { id: 'd3', status: 'Available' }],
    helpers: [{ id: 'h1', status: 'Available' }, { id: 'h2', status: 'Available' }, { id: 'h3', status: 'Available' }],
    assignments: [{ serviceDate: '2026-12-01', state: 'CONFIRMED', vehicleId: 'v1', driverId: 'd1', helperIds: ['h1', 'h2'] }],
    availabilityError: null,
    today: '2026-11-09',
  });
  assert.equal(plan.status, 'ok');
  const trucks = plan.resources.find((r) => r.key === 'trucks')!;
  const helpers = plan.resources.find((r) => r.key === 'helpers')!;
  // Dec 1: one assigned booking (1 truck) + 2 more expected × 1 truck = 3 trucks vs 2 usable.
  assert.equal(trucks.peakRequired, 3);
  assert.equal(trucks.usableOnPeak, 2);
  assert.equal(trucks.shortage, 1);
  // Helpers: 2 assigned + ceil(2 × 1.5) = 5 needed vs 3 on the roster.
  assert.equal(helpers.peakRequired, 5);
  assert.equal(helpers.shortage, 2);
  assert.equal(plan.crewUnavailable.drivers, 1);
  assert.ok(plan.recommendations.some((item) => item.kind === 'shortage' && item.text.startsWith('Arrange 1 more truck for')));
});

test('resource plan refuses to estimate without enough crew records', () => {
  const plan = planResources({
    forecast: [{ date: '2026-12-01', forecast: 2 }],
    basis: { totalBookings: 10, knownBookings: 2, fromAssignments: 2, fromBookingNotes: 0, totals: { trucks: 2, drivers: 2, helpers: 4 } },
    vehicles: [], drivers: [], helpers: [], assignments: [], availabilityError: null, today: '2026-11-09',
  });
  assert.equal(plan.status, 'insufficient-data');
  assert.equal(plan.resources.length, 0);
});

test('LLM grounding drops statements with figures absent from the facts', () => {
  const allowed = allowedNumbers({ total: 42, changePct: -12.5, peak: { start: '2026-12-15' }, share: 34.44 });
  assert.equal(isGrounded('About 42 bookings, down 12.5% (peak Dec 15).', allowed), true);
  assert.equal(isGrounded('Lipat Bahay is 34.4% of demand.', allowed), true);
  assert.equal(isGrounded('Prepare 3 additional trucks.', allowed), false);
  const { insights, removed } = groundItems({
    keyInsights: [{ title: 'Demand', detail: '42 bookings expected', category: 'demand' }, { title: 'Accuracy', detail: 'Forecast is 92.5% accurate', category: 'demand' }],
    recommendedActions: [{ action: 'Review crew schedules', reason: 'Peak on Dec 15', priority: 'high' }],
    risks: [],
  }, allowed);
  assert.equal(insights.keyInsights.length, 1);
  assert.equal(insights.recommendedActions.length, 1);
  assert.equal(removed, 1);
});
