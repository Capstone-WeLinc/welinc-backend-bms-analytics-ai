/**
 * Pure forecasting calculations for the AI Demand Forecasting module.
 *
 * Nothing here touches a database or the LLM: every number shown on the
 * dashboards is produced by these functions from real booking records, so they
 * can be unit tested and explained. The LLM only interprets the results.
 */

export const DAY_MS = 86_400_000;

/** Recent weeks count more than older ones; a booking 28 days old weighs half as much as today's. */
export const HALF_LIFE_DAYS = 28;
/** Below this many days of history a weekday pattern is unreliable, so the historical average is used. */
export const MIN_DAYS_FOR_WEEKDAY_MODEL = 14;
/** Days held out when testing the model against bookings that really happened (7 when history is short). */
export const BACKTEST_TEST_DAYS = 14;
export const SHORT_BACKTEST_TEST_DAYS = 7;
export const MIN_BACKTEST_TRAINING_DAYS = 14;

export type ForecastHorizon = '7days' | '30days' | '90days' | 'nextMonth';
export type ForecastMethod = 'weighted-weekday' | 'historical-average' | 'none';

export interface DailyActual { date: string; actual: number }
export interface DailyForecast { date: string; forecast: number }

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function dateRange(start: string, end: string): string[] {
  const days: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) days.push(date);
  return days;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The forecast window that follows the history window. */
export function forecastWindow(historyEnd: string, horizon: ForecastHorizon): { start: string; end: string; days: number } {
  if (horizon === 'nextMonth') {
    const [year, month] = historyEnd.split('-').map(Number);
    const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    return { start, end, days: daysBetween(start, end) + 1 };
  }
  const days = horizon === '7days' ? 7 : horizon === '90days' ? 90 : 30;
  const start = addDays(historyEnd, 1);
  return { start, end: addDays(start, days - 1), days };
}

/** Booking counts for every day in [start, end], including days with no bookings. */
export function dailyCounts(dates: string[], start: string, end: string): DailyActual[] {
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(date, (counts.get(date) ?? 0) + 1);
  return dateRange(start, end).map((date) => ({ date, actual: counts.get(date) ?? 0 }));
}

export interface FittedModel {
  method: ForecastMethod;
  /** Expected bookings for each weekday (0 = Sunday). */
  weekdayRates: number[];
  overallRate: number;
  trainingDays: number;
  trainingBookings: number;
  fallbackReason?: string;
}

/**
 * Primary model: an exponentially weighted average of bookings for each weekday,
 * so recent weeks dominate while the weekly pattern is kept.
 * Fallback: the plain historical average per day (used when there is too little
 * history for a weekday pattern, or a weekday has never been observed).
 */
export function fitModel(history: DailyActual[]): FittedModel {
  const trainingBookings = history.reduce((sum, day) => sum + day.actual, 0);
  const trainingDays = history.length;
  if (trainingDays === 0) {
    return { method: 'none', weekdayRates: Array(7).fill(0), overallRate: 0, trainingDays, trainingBookings, fallbackReason: 'No booking history in the selected range.' };
  }
  const overallRate = trainingBookings / trainingDays;
  if (trainingDays < MIN_DAYS_FOR_WEEKDAY_MODEL) {
    return {
      method: 'historical-average', weekdayRates: Array(7).fill(overallRate), overallRate, trainingDays, trainingBookings,
      fallbackReason: `Only ${trainingDays} days of history; at least ${MIN_DAYS_FOR_WEEKDAY_MODEL} are needed for a weekday pattern.`,
    };
  }
  const last = history[history.length - 1].date;
  const sums = Array(7).fill(0) as number[];
  const weights = Array(7).fill(0) as number[];
  for (const day of history) {
    const age = daysBetween(day.date, last);
    const weight = Math.pow(0.5, age / HALF_LIFE_DAYS);
    const index = weekday(day.date);
    sums[index] += weight * day.actual;
    weights[index] += weight;
  }
  if (weights.some((weight) => weight === 0)) {
    return {
      method: 'historical-average', weekdayRates: Array(7).fill(overallRate), overallRate, trainingDays, trainingBookings,
      fallbackReason: 'Some weekdays have no history yet, so the historical daily average is used.',
    };
  }
  return { method: 'weighted-weekday', weekdayRates: sums.map((sum, index) => sum / weights[index]), overallRate, trainingDays, trainingBookings };
}

export function predict(model: FittedModel, start: string, end: string): DailyForecast[] {
  return dateRange(start, end).map((date) => ({ date, forecast: model.weekdayRates[weekday(date)] }));
}

export interface ErrorMetrics { mae: number | null; mape: number | null; mapeDaysUsed: number; zeroActualDays: number }

/**
 * MAE over every compared point. MAPE only over points whose actual value is
 * above zero (it is undefined when the actual is zero); null when none qualify.
 */
export function errorMetrics(points: { actual: number; predicted: number }[]): ErrorMetrics {
  if (!points.length) return { mae: null, mape: null, mapeDaysUsed: 0, zeroActualDays: 0 };
  const mae = points.reduce((sum, point) => sum + Math.abs(point.actual - point.predicted), 0) / points.length;
  const withActual = points.filter((point) => point.actual > 0);
  const mape = withActual.length
    ? (withActual.reduce((sum, point) => sum + Math.abs(point.actual - point.predicted) / point.actual, 0) / withActual.length) * 100
    : null;
  return { mae, mape, mapeDaysUsed: withActual.length, zeroActualDays: points.length - withActual.length };
}

export interface Backtest extends ErrorMetrics {
  available: boolean;
  reason?: string;
  method?: ForecastMethod;
  trainingDays: number;
  testDays: number;
  testStart: string | null;
  testEnd: string | null;
  totalActual: number;
  totalPredicted: number;
  /** Error of the period total, which is what the KPI cards report. */
  totalErrorPct: number | null;
  points: { date: string; actual: number; predicted: number }[];
}

/**
 * Re-fits the model without the most recent days (14, or 7 when history is short)
 * and compares its predictions with the bookings that really happened.
 */
export function backtest(history: DailyActual[]): Backtest {
  const empty = { mae: null, mape: null, mapeDaysUsed: 0, zeroActualDays: 0, trainingDays: 0, testDays: 0, testStart: null, testEnd: null, totalActual: 0, totalPredicted: 0, totalErrorPct: null, points: [] };
  const testDays = history.length >= MIN_BACKTEST_TRAINING_DAYS + BACKTEST_TEST_DAYS ? BACKTEST_TEST_DAYS : SHORT_BACKTEST_TEST_DAYS;
  if (history.length < MIN_BACKTEST_TRAINING_DAYS + testDays) {
    return { ...empty, available: false, reason: `At least ${MIN_BACKTEST_TRAINING_DAYS + SHORT_BACKTEST_TEST_DAYS} days of booking history are needed to test the forecast; ${history.length} available.` };
  }
  const training = history.slice(0, -testDays);
  const test = history.slice(-testDays);
  const model = fitModel(training);
  const points = test.map((day) => ({ date: day.date, actual: day.actual, predicted: round1(model.weekdayRates[weekday(day.date)]) }));
  const totalActual = test.reduce((sum, day) => sum + day.actual, 0);
  const totalPredicted = round1(test.reduce((sum, day) => sum + model.weekdayRates[weekday(day.date)], 0));
  if (training.every((day) => day.actual === 0)) {
    return { ...empty, available: false, reason: 'The training part of the history has no bookings, so the forecast cannot be tested yet.' };
  }
  return {
    available: true, method: model.method, ...errorMetrics(test.map((day) => ({ actual: day.actual, predicted: model.weekdayRates[weekday(day.date)] }))),
    trainingDays: training.length, testDays: test.length, testStart: test[0].date, testEnd: test[test.length - 1].date,
    totalActual, totalPredicted, totalErrorPct: totalActual > 0 ? (Math.abs(totalActual - totalPredicted) / totalActual) * 100 : null, points,
  };
}

/**
 * Highest-demand consecutive 7-day window in the forecast. `distinct` is false when
 * every window is within 3% of the busiest one, i.e. there is no real peak week
 * (a weekday pattern repeats every week), so callers should not present one.
 */
export function peakWeek(daily: DailyForecast[]): { start: string; end: string; bookings: number; distinct: boolean } | null {
  if (daily.length < 7) return null;
  let best = { index: 0, total: -1 };
  let lowest = Infinity;
  for (let index = 0; index + 7 <= daily.length; index += 1) {
    const total = daily.slice(index, index + 7).reduce((sum, day) => sum + day.forecast, 0);
    lowest = Math.min(lowest, total);
    if (total > best.total + 1e-9) best = { index, total };
  }
  const distinct = best.total > 0 && (best.total - lowest) / best.total >= 0.03;
  return { start: daily[best.index].date, end: daily[best.index + 6].date, bookings: best.total, distinct };
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Groups days into consecutive 7-day blocks starting at `anchor` (blocks before it run backwards). */
export function sevenDayBlocks<T extends { date: string }>(days: T[], anchor: string, direction: 'forward' | 'backward'): T[][] {
  const blocks = new Map<number, T[]>();
  for (const day of days) {
    const offset = direction === 'forward' ? daysBetween(anchor, day.date) : daysBetween(day.date, anchor);
    const index = Math.floor(offset / 7);
    blocks.set(index, [...(blocks.get(index) ?? []), day]);
  }
  return [...blocks.entries()].sort(([a], [b]) => (direction === 'forward' ? a - b : b - a)).map(([, block]) => block);
}

export function peakDay(daily: DailyForecast[]): DailyForecast | null {
  return daily.reduce<DailyForecast | null>((best, day) => (!best || day.forecast > best.forecast + 1e-9 ? day : best), null);
}

/** 'High' / 'Low' when the forecast daily average is at least 15% above / below the recent history. */
export function demandLevel(forecastDailyAverage: number, historicalDailyAverage: number): { level: 'High' | 'Moderate' | 'Low'; ratio: number } | null {
  if (historicalDailyAverage <= 0) return null;
  const ratio = forecastDailyAverage / historicalDailyAverage;
  return { level: ratio >= 1.15 ? 'High' : ratio <= 0.85 ? 'Low' : 'Moderate', ratio };
}

export function percentChange(current: number, previous: number): number | null {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

export const SERVICE_TYPES = ['Corporate Delivery', 'Lipat Bahay', 'Office Pull Out', 'Unit to Unit Transfer'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
const SERVICE_KEYS: [string, ServiceType][] = [
  ['corporatedelivery', 'Corporate Delivery'],
  ['lipatbahay', 'Lipat Bahay'],
  ['officepullout', 'Office Pull Out'],
  ['unittounittransfer', 'Unit to Unit Transfer'],
];
const normalizeService = (value: string | null | undefined) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Maps a booking to one of the four WeLinc service types using only what the
 * record states (the service type first, then the service name). Wix
 * appointments that only name a truck rate are left unmapped instead of guessed.
 */
export function mapServiceType(serviceType: string | null | undefined, service: string | null | undefined): ServiceType | null {
  for (const value of [serviceType, service]) {
    const key = normalizeService(value);
    if (!key) continue;
    const match = SERVICE_KEYS.find(([alias]) => key.includes(alias));
    if (match) return match[1];
  }
  return null;
}

export interface CrewRequirement { trucks: number; drivers: number; helpers: number; source: 'assignment' | 'booking-notes' }

/**
 * The crew a booking needed, from real records only: the dispatch assignment when
 * a truck was assigned, otherwise the "Welinc service resource" line that Wix
 * appointments carry (e.g. "14FT: 1 DRIVER + 2 HELPERS"). Null when unknown.
 */
export function crewRequirement(
  notes: string | null | undefined,
  assignment: { vehicleId?: string | null; driverId?: string | null; helperIds?: string[] | null } | null | undefined,
): CrewRequirement | null {
  if (assignment?.vehicleId) {
    return { trucks: 1, drivers: assignment.driverId ? 1 : 0, helpers: assignment.helperIds?.length ?? 0, source: 'assignment' };
  }
  const match = /Welinc service resource:\s*[^:\n]+:\s*(\d+)\s*DRIVERS?\s*\+\s*(\d+)\s*HELPERS?/i.exec(notes ?? '');
  if (match) return { trucks: 1, drivers: Number(match[1]), helpers: Number(match[2]), source: 'booking-notes' };
  return null;
}

/** Monday-start week key, used to group days into weeks. */
export function weekStart(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}
