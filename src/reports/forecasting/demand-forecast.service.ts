import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { PrismaService } from '../../shared/prisma.service';
import { ReportStorage } from '../../shared/report-storage.service';
import type { ForecastDto } from '../dto/forecast.dto';
import {
  HALF_LIFE_DAYS, SERVICE_TYPES, WEEKDAY_NAMES, addDays, backtest, crewRequirement, dailyCounts, daysBetween, demandLevel, errorMetrics,
  fitModel, forecastWindow, mapServiceType, peakDay, peakWeek, percentChange, predict, round1, sevenDayBlocks, weekday,
  type ServiceType,
} from './forecast-engine';
import { planResources, type AssignmentInput, type CrewInput, type RequirementBasis, type VehicleInput } from './resource-planner';
import { INSIGHTS_SYSTEM_PROMPT, allowedNumbers, buildFacts, buildSystemInsights, groundItems } from './insights';
import type { AiInsightsResponse, ForecastDashboard, SavedForecastEvaluation } from './forecast.types';

const PRIMARY_MODEL = 'llama-3.3-70b-versatile';
const DASHBOARD_TTL_MS = 60_000;
const INSIGHTS_TTL_MS = 10 * 60_000;
const LIMITED_HISTORY_DAYS = 60;
const LIMITED_HISTORY_BOOKINGS = 30;
const MIN_BOOKINGS_FOR_LEVEL = 5;

type BookingRow = {
  id: string; service: string; service_type: string | null; date: string; status: string; notes: string | null;
  scheduledBooking: { vehicleId: string | null; driverId: string | null; helperIds: string[] } | null;
};

const manilaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const isCancelled = (status: string) => /cancel/i.test(status ?? '');
const fmt = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

@Injectable()
export class DemandForecastService {
  private readonly logger = new Logger('DemandForecast');
  private readonly groq: Groq | null;
  private readonly dashboards = new Map<string, { at: number; value: Promise<ForecastDashboard> }>();
  private readonly insights = new Map<string, { at: number; value: Promise<AiInsightsResponse> }>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: ReportStorage,
  ) {
    const apiKey = this.config.get<string>('GROQ_API_KEY');
    this.groq = apiKey ? new Groq({ apiKey }) : null;
  }

  /** One computation serves all four tabs; concurrent and repeated requests share it briefly. */
  getDashboard(dto: ForecastDto, authorization: string | undefined): Promise<ForecastDashboard> {
    const key = JSON.stringify([dto.startDate.slice(0, 10), dto.endDate.slice(0, 10), dto.forecastHorizon, dto.serviceType ?? 'All', dto.vehicleId ?? 'All', dto.garage ?? 'All']);
    const cached = this.dashboards.get(key);
    if (cached && Date.now() - cached.at < DASHBOARD_TTL_MS) return cached.value;
    const value = this.computeDashboard(dto, authorization);
    this.dashboards.set(key, { at: Date.now(), value });
    value.catch(() => this.dashboards.delete(key));
    for (const [entryKey, entry] of this.dashboards) if (Date.now() - entry.at > DASHBOARD_TTL_MS) this.dashboards.delete(entryKey);
    return value;
  }

  async getAiInsights(dto: ForecastDto, authorization: string | undefined): Promise<AiInsightsResponse> {
    const dashboard = await this.getDashboard(dto, authorization);
    const generatedAt = new Date().toISOString();
    if (!dashboard.demand || dashboard.dataQuality.trainingBookings === 0) {
      return { status: 'empty', model: null, generatedAt, insights: null, removedUnverified: 0, message: 'There is no booking history for these filters, so there is nothing for the AI to interpret yet.' };
    }
    const facts = buildFacts(dashboard);
    const key = JSON.stringify(facts);
    const cached = this.insights.get(key);
    if (cached && !dto.refreshInsights && Date.now() - cached.at < INSIGHTS_TTL_MS) return cached.value;
    const value = this.generateInsights(facts);
    this.insights.set(key, { at: Date.now(), value });
    value.then((result) => { if (result.status !== 'ok') this.insights.delete(key); }, () => this.insights.delete(key));
    return value;
  }

  private async generateInsights(facts: ReturnType<typeof buildFacts>): Promise<AiInsightsResponse> {
    if (!this.groq) {
      return { status: 'unavailable', model: null, generatedAt: new Date().toISOString(), insights: null, removedUnverified: 0, message: 'AI interpretation is not configured. Rule-based forecast insights remain available.' };
    }
    const allowed = allowedNumbers(facts);
    const fallback = this.config.get<string>('GROQ_MODEL');
    const models = [PRIMARY_MODEL, ...(fallback && fallback !== PRIMARY_MODEL ? [fallback] : [])];
    let lastError = 'The AI service could not be reached.';
    for (const model of models) {
      try {
        const completion = await this.groq.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: 3000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: INSIGHTS_SYSTEM_PROMPT },
            { role: 'user', content: `Verified forecast results:\n${JSON.stringify(facts)}` },
          ],
        }, { timeout: 45_000 });
        const content = completion.choices[0]?.message?.content ?? '';
        const match = content.match(/\{[\s\S]*\}/);
        const { insights, removed } = groundItems(JSON.parse(match ? match[0] : content), allowed);
        const generatedAt = new Date().toISOString();
        if (!insights.keyInsights.length && !insights.recommendedActions.length && !insights.risks.length) {
          return { status: 'empty', model, generatedAt, insights: null, removedUnverified: removed, message: 'The AI response had no statements that could be verified against the forecast data.' };
        }
        return { status: 'ok', model, generatedAt, insights, removedUnverified: removed, message: model === PRIMARY_MODEL ? null : `${PRIMARY_MODEL} is not available for the configured Groq key, so ${model} was used.` };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(`AI insights with ${model} failed: ${lastError.slice(0, 200)}`);
      }
    }
    return { status: 'unavailable', model: null, generatedAt: new Date().toISOString(), insights: null, removedUnverified: 0, message: 'The AI interpretation is unavailable right now. Rule-based insights from the forecast data are shown instead.' };
  }

  private async computeDashboard(dto: ForecastDto, authorization: string | undefined): Promise<ForecastDashboard> {
    const today = manilaToday();
    const historyStart = dto.startDate.slice(0, 10);
    const historyEnd = dto.endDate.slice(0, 10);
    const window = forecastWindow(historyEnd, dto.forecastHorizon);
    const fetchStart = [historyStart, addDays(today, -400)].sort()[0];
    const serviceFilter = dto.serviceType && dto.serviceType !== 'All' ? dto.serviceType : null;
    const vehicleFilter = dto.vehicleId && dto.vehicleId !== 'All' ? dto.vehicleId : null;
    const garageFilter = dto.garage && dto.garage !== 'All' ? dto.garage : null;

    const [rows, resourceData] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          deleted_at: null,
          date: { gte: fetchStart, lte: `${window.end}T23:59:59.999Z` },
          ...(vehicleFilter || garageFilter ? { scheduledBooking: { is: { ...(vehicleFilter ? { vehicleId: vehicleFilter } : {}), ...(garageFilter ? { garage: garageFilter } : {}) } } } : {}),
        },
        select: { id: true, service: true, service_type: true, date: true, status: true, notes: true, scheduledBooking: { select: { vehicleId: true, driverId: true, helperIds: true } } },
      }) as Promise<BookingRow[]>,
      this.loadResources(authorization),
    ]);

    const canonicalFilter = serviceFilter ? mapServiceType(serviceFilter, null) : null;
    const matchesService = (row: BookingRow) => !serviceFilter
      || (canonicalFilter ? mapServiceType(row.service_type, row.service) === canonicalFilter : row.service === serviceFilter);
    const active = rows.filter((row) => !isCancelled(row.status));
    const bookings = active.filter(matchesService).map((row) => ({ ...row, day: String(row.date).slice(0, 10) }));
    const cancelledExcluded = rows.filter((row) => isCancelled(row.status) && matchesService(row)).length;

    // The system has no records before its first booking, so those days are not counted as zero demand.
    const firstBooking = active.map((row) => String(row.date).slice(0, 10)).sort()[0] ?? null;
    const trainingStart = firstBooking ? [historyStart, firstBooking].sort()[1] : null;
    const trainingEnd = [historyEnd, today].sort()[0];
    const hasWindow = Boolean(trainingStart && trainingStart <= trainingEnd);
    const inTraining = hasWindow ? bookings.filter((b) => b.day >= trainingStart! && b.day <= trainingEnd) : [];
    const history = hasWindow ? dailyCounts(inTraining.map((b) => b.day), trainingStart!, trainingEnd) : [];
    const model = fitModel(history);
    const historicalBookings = bookings.filter((b) => b.day >= historyStart && b.day <= historyEnd).length;

    const bookedInWindow = new Map<string, number>();
    bookings.filter((b) => b.day >= window.start && b.day <= window.end).forEach((b) => bookedInWindow.set(b.day, (bookedInWindow.get(b.day) ?? 0) + 1));
    const alreadyBooked = [...bookedInWindow.values()].reduce((sum, n) => sum + n, 0);
    // Bookings already on the calendar are known demand: a day is never forecast below them.
    const daily = model.method === 'none' ? [] : predict(model, window.start, window.end).map((day) => ({
      date: day.date, forecast: Math.max(day.forecast, bookedInWindow.get(day.date) ?? 0), alreadyBooked: bookedInWindow.get(day.date) ?? 0,
    }));
    const forecastTotalRaw = daily.reduce((sum, day) => sum + day.forecast, 0);

    const dataQuality: ForecastDashboard['dataQuality'] = {
      historicalBookings, cancelledExcluded, trainingStart: hasWindow ? trainingStart : null, trainingDays: history.length,
      trainingBookings: model.trainingBookings,
      limitedHistory: history.length < LIMITED_HISTORY_DAYS || model.trainingBookings < LIMITED_HISTORY_BOOKINGS,
      note: hasWindow && trainingStart !== historyStart ? `Days before the first recorded booking (${fmt(trainingStart!)}) are excluded from training.` : null,
    };
    const method: ForecastDashboard['method'] = model.method === 'weighted-weekday'
      ? { name: model.method, label: 'Weighted weekday average', description: `Expected bookings for each weekday, with recent weeks weighted more (a booking ${HALF_LIFE_DAYS} days old counts half).`, fallbackReason: null, halfLifeDays: HALF_LIFE_DAYS }
      : model.method === 'historical-average'
        ? { name: model.method, label: 'Historical daily average (fallback)', description: 'Average bookings per day over the history used.', fallbackReason: model.fallbackReason ?? null, halfLifeDays: HALF_LIFE_DAYS }
        : { name: 'none', label: 'No forecast', description: 'There is no booking history to learn from.', fallbackReason: model.fallbackReason ?? null, halfLifeDays: HALF_LIFE_DAYS };

    // Previous equivalent period: the same number of days immediately before the history end.
    const previousDays = history.slice(-window.days);
    const previousActual = previousDays.reduce((sum, day) => sum + day.actual, 0);
    const previousDailyAverage = previousDays.length ? previousActual / previousDays.length : 0;
    const forecastDailyAverage = window.days ? forecastTotalRaw / window.days : 0;
    const historicalDailyAverage = history.length ? model.trainingBookings / history.length : 0;

    let demand: ForecastDashboard['demand'] = null;
    if (model.method !== 'none') {
      const pDay = peakDay(daily);
      const pWeek = peakWeek(daily);
      const peakDates = pDay ? daily.filter((day) => Math.abs(day.forecast - pDay.forecast) < 0.05).map((day) => day.date) : [];
      // A High/Moderate/Low label from a handful of bookings would be noise, so it needs some history.
      const level = model.trainingBookings >= MIN_BOOKINGS_FOR_LEVEL ? demandLevel(forecastDailyAverage, historicalDailyAverage) : null;
      const changePct = percentChange(forecastDailyAverage, previousDailyAverage);
      const totalForecast = Math.round(forecastTotalRaw);
      demand = {
        totalForecast,
        dailyAverage: round1(forecastDailyAverage),
        alreadyBooked,
        previousPeriod: {
          start: previousDays[0]?.date ?? trainingEnd, end: previousDays[previousDays.length - 1]?.date ?? trainingEnd,
          days: previousDays.length, actual: previousActual, dailyAverage: round1(previousDailyAverage), changePct,
        },
        demandLevel: level ? { ...level, historicalDailyAverage: round1(historicalDailyAverage) } : null,
        peakDay: pDay ? { date: pDay.date, bookings: round1(pDay.forecast) } : null,
        peakWeek: pWeek?.distinct ? { start: pWeek.start, end: pWeek.end, bookings: round1(pWeek.bookings), sharePct: forecastTotalRaw > 0 ? (pWeek.bookings / forecastTotalRaw) * 100 : 0 } : null,
        peakPattern: pDay && pDay.forecast > 0 ? { weekday: WEEKDAY_NAMES[weekday(pDay.date)], bookings: round1(pDay.forecast), dates: peakDates } : null,
        daily: daily.map((day) => ({ ...day, forecast: round1(day.forecast) })),
        history,
        weekly: this.weekly(history, daily, trainingEnd, window.start),
        monthly: this.monthly(history, daily),
        summary: `Based on ${model.trainingBookings} bookings over ${history.length} days (${fmt(history[0].date)} – ${fmt(history[history.length - 1].date)}), about ${totalForecast} bookings are expected from ${fmt(window.start)} to ${fmt(window.end)} (${round1(forecastDailyAverage)} per day)`
          + (changePct === null ? '.' : `, ${changePct >= 0 ? 'up' : 'down'} ${round1(Math.abs(changePct))}% per day compared with the previous ${previousDays.length} days (${round1(previousDailyAverage)} per day).`)
          + (alreadyBooked ? ` ${alreadyBooked} of these are already booked.` : ''),
      };
    }

    const services = this.serviceDemand(inTraining, previousDays, forecastTotalRaw, window.days, trainingEnd);
    const basis: RequirementBasis = { totalBookings: 0, knownBookings: 0, fromAssignments: 0, fromBookingNotes: 0, totals: { trucks: 0, drivers: 0, helpers: 0 } };
    bookings.filter((b) => hasWindow && b.day >= trainingStart! && b.day <= window.end).forEach((b) => {
      basis.totalBookings += 1;
      const need = crewRequirement(b.notes, b.scheduledBooking);
      if (!need) return;
      basis.knownBookings += 1;
      if (need.source === 'assignment') basis.fromAssignments += 1; else basis.fromBookingNotes += 1;
      basis.totals.trucks += need.trucks; basis.totals.drivers += need.drivers; basis.totals.helpers += need.helpers;
    });
    const vehicles = resourceData.vehicles && vehicleFilter ? resourceData.vehicles.filter((v) => v.id === vehicleFilter) : resourceData.vehicles;
    const resources = planResources({
      forecast: daily, basis, vehicles, drivers: resourceData.drivers, helpers: resourceData.helpers,
      assignments: resourceData.assignments, availabilityError: resourceData.error, today,
    });

    const evaluation = {
      backtest: backtest(history),
      savedForecasts: await this.evaluateSavedForecasts(bookings, { serviceFilter, vehicleFilter, garageFilter, fetchStart, today }),
    };

    const dashboard: ForecastDashboard = {
      generatedAt: new Date().toISOString(),
      params: { historyStart, historyEnd, horizon: dto.forecastHorizon, forecastStart: window.start, forecastEnd: window.end, forecastDays: window.days, serviceType: serviceFilter ?? 'All', vehicleId: vehicleFilter ?? 'All' },
      method, dataQuality, demand, evaluation, services, resources,
      systemInsights: { summary: '', keyInsights: [], recommendedActions: [], risks: [] },
    };
    dashboard.systemInsights = buildSystemInsights(dashboard);
    if (demand && !vehicleFilter && !garageFilter) void this.recordForecast(dashboard);
    return dashboard;
  }

  /** 7-day blocks ending at the history end (last 8) and starting at the forecast start, so there are no 1-day "weeks". */
  private weekly(history: { date: string; actual: number }[], daily: { date: string; forecast: number }[], historyEnd: string, forecastStart: string) {
    const past = sevenDayBlocks(history.slice(-56), historyEnd, 'backward').map((block) => ({
      start: block[0].date, end: block[block.length - 1].date, days: block.length,
      actual: block.reduce((sum, day) => sum + day.actual, 0), forecast: null as number | null,
    }));
    const future = sevenDayBlocks(daily, forecastStart, 'forward').map((block) => ({
      start: block[0].date, end: block[block.length - 1].date, days: block.length,
      actual: null as number | null, forecast: round1(block.reduce((sum, day) => sum + day.forecast, 0)),
    }));
    return [...past, ...future];
  }

  private monthly(history: { date: string; actual: number }[], daily: { date: string; forecast: number }[]) {
    const months = new Map<string, { actual: number | null; forecast: number | null; days: number }>();
    const add = (date: string, field: 'actual' | 'forecast', value: number) => {
      const key = date.slice(0, 7);
      const month = months.get(key) ?? { actual: null, forecast: null, days: 0 };
      month[field] = (month[field] ?? 0) + value;
      month.days += 1;
      months.set(key, month);
    };
    history.forEach((day) => add(day.date, 'actual', day.actual));
    daily.forEach((day) => add(day.date, 'forecast', day.forecast));
    return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, value]) => {
      const [year, m] = month.split('-').map(Number);
      const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
      return { month, actual: value.actual, forecast: value.forecast === null ? null : round1(value.forecast), partial: value.days < daysInMonth };
    });
  }

  private serviceDemand(
    training: { day: string; service: string; service_type: string | null }[],
    previousDays: { date: string }[],
    forecastTotal: number,
    forecastDays: number,
    trainingEnd: string,
  ): ForecastDashboard['services'] {
    const weightOf = (day: string) => Math.pow(0.5, daysBetween(day, trainingEnd) / HALF_LIFE_DAYS);
    const previousStart = previousDays[0]?.date ?? '9999-12-31';
    const stats = new Map<ServiceType | null, { historical: number; previous: number; weight: number }>();
    const unmappedNames = new Map<string, number>();
    let totalWeight = 0;
    for (const booking of training) {
      const type = mapServiceType(booking.service_type, booking.service);
      const entry = stats.get(type) ?? { historical: 0, previous: 0, weight: 0 };
      const weight = weightOf(booking.day);
      entry.historical += 1;
      entry.weight += weight;
      if (booking.day >= previousStart) entry.previous += 1;
      stats.set(type, entry);
      totalWeight += weight;
      if (!type) unmappedNames.set(booking.service, (unmappedNames.get(booking.service) ?? 0) + 1);
    }
    const previousLength = Math.max(1, previousDays.length);
    const forecastFor = (weight: number) => (totalWeight > 0 ? (weight / totalWeight) * forecastTotal : 0);
    const mappedForecast = SERVICE_TYPES.reduce((sum, type) => sum + forecastFor(stats.get(type)?.weight ?? 0), 0);
    const rows = SERVICE_TYPES.map((service) => {
      const entry = stats.get(service) ?? { historical: 0, previous: 0, weight: 0 };
      const forecast = forecastFor(entry.weight);
      const changePct = percentChange(forecast / Math.max(1, forecastDays), entry.previous / previousLength);
      // A trend needs a change of at least one booking over the previous period, so one-off bookings do not read as growth.
      const scaledChange = (forecast / Math.max(1, forecastDays)) * previousLength - entry.previous;
      const trend: ForecastDashboard['services']['rows'][number]['trend'] = entry.previous === 0
        ? (forecast > 0 ? 'new' : 'none')
        : changePct! >= 10 && scaledChange >= 1 ? 'up' : changePct! <= -10 && scaledChange <= -1 ? 'down' : 'flat';
      return { service, historical: entry.historical, previousActual: entry.previous, forecast: round1(forecast), forecastSharePct: mappedForecast > 0 ? (forecast / mappedForecast) * 100 : 0, changePct, trend };
    });
    const unmapped = stats.get(null) ?? { historical: 0, previous: 0, weight: 0 };
    const ranked = rows.filter((row) => row.historical > 0).sort((a, b) => b.forecast - a.forecast);
    const previousMapped = rows.reduce((sum, row) => sum + row.previousActual, 0);
    return {
      rows,
      unclassified: {
        historical: unmapped.historical, forecast: round1(forecastFor(unmapped.weight)),
        sharePct: forecastTotal > 0 ? (forecastFor(unmapped.weight) / forecastTotal) * 100 : 0,
        examples: [...unmappedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name),
      },
      totalHistoricalMapped: rows.reduce((sum, row) => sum + row.historical, 0),
      totalForecastMapped: round1(mappedForecast),
      previousMapped,
      growthPct: percentChange(mappedForecast / Math.max(1, forecastDays), previousMapped / previousLength),
      mostDemanded: ranked[0]?.service ?? null,
      leastDemanded: ranked.length > 1 ? [...rows].sort((a, b) => a.forecast - b.forecast)[0].service : null,
    };
  }

  /** Trucks, drivers, helpers and schedule assignments from the dispatch service, read with the Admin's own token. */
  private async loadResources(authorization: string | undefined): Promise<{
    vehicles: VehicleInput[] | null; drivers: CrewInput[] | null; helpers: CrewInput[] | null; assignments: AssignmentInput[] | null; error: string | null;
  }> {
    const base = this.config.get<string>('DISPATCH_API_URL') || 'http://127.0.0.1:3022';
    if (!authorization) return { vehicles: null, drivers: null, helpers: null, assignments: null, error: 'Resource availability needs an authenticated request.' };
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(new URL(path, base), { headers: { authorization }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return response.json() as Promise<T>;
    };
    try {
      const [vehicles, drivers, helpers, assignments] = await Promise.all([
        get<VehicleInput[]>('/bms/config/vehicles'),
        get<CrewInput[]>('/bms/config/drivers'),
        get<CrewInput[]>('/bms/config/helpers'),
        get<AssignmentInput[]>('/dispatch/assignments'),
      ]);
      return { vehicles, drivers, helpers, assignments, error: null };
    } catch (error) {
      this.logger.warn(`Resource availability unavailable: ${error instanceof Error ? error.message : error}`);
      return { vehicles: null, drivers: null, helpers: null, assignments: null, error: 'Truck and crew availability could not be loaded from the dispatch service.' };
    }
  }

  /** Compares earlier saved forecasts with the bookings that actually happened in their forecast window. */
  private async evaluateSavedForecasts(
    bookings: { day: string }[],
    context: { serviceFilter: string | null; vehicleFilter: string | null; garageFilter: string | null; fetchStart: string; today: string },
  ): Promise<SavedForecastEvaluation> {
    const none = (reason: string): SavedForecastEvaluation => ({ available: false, reason, evaluatedCount: 0, mae: null, mape: null, records: [] });
    if (context.vehicleFilter || context.garageFilter) return none('Saved forecasts are recorded for all vehicles, so they are not evaluated for a single vehicle.');
    interface Row { id: number; forecast_horizon: string; service_type: string | null; predicted_bookings: number; forecast_data: unknown; generated_at: Date | string }
    let rows: Row[];
    try {
      rows = await this.storage.query<Row[]>(
        `SELECT id, forecast_horizon, service_type, predicted_bookings, forecast_data, generated_at
         FROM ai_demand_forecasts WHERE garage IS NULL AND ${context.serviceFilter ? 'service_type = ?' : 'service_type IS NULL'}
         ORDER BY id DESC LIMIT 1000`,
        context.serviceFilter ? [context.serviceFilter] : [],
      );
    } catch {
      return none('Saved forecast history (PostgreSQL) is unavailable.');
    }
    const latestByTarget = new Map<string, SavedForecastEvaluation['records'][number]>();
    for (const row of rows) {
      let data: unknown = row.forecast_data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = []; } }
      const dates = (Array.isArray(data) ? data : []).map((point: any) => String(point?.date ?? '')).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
      if (!dates.length) continue;
      const targetStart = dates[0];
      const targetEnd = dates[dates.length - 1];
      if (targetEnd >= context.today || targetStart < context.fetchStart) continue;
      const key = `${row.forecast_horizon}|${targetStart}|${targetEnd}`;
      if (latestByTarget.has(key)) continue;
      const actual = bookings.filter((b) => b.day >= targetStart && b.day <= targetEnd).length;
      const predicted = Number(row.predicted_bookings) || 0;
      latestByTarget.set(key, {
        id: row.id, generatedAt: new Date(row.generated_at).toISOString(), horizon: row.forecast_horizon, targetStart, targetEnd,
        predicted, actual, absError: Math.abs(predicted - actual), ape: actual > 0 ? (Math.abs(predicted - actual) / actual) * 100 : null,
      });
    }
    const records = [...latestByTarget.values()].sort((a, b) => b.targetEnd.localeCompare(a.targetEnd));
    if (!records.length) return none('No saved forecast has a forecast period that has fully passed yet. Results appear here once one does.');
    const metrics = errorMetrics(records.map((record) => ({ actual: record.actual, predicted: record.predicted })));
    return { available: true, evaluatedCount: records.length, mae: metrics.mae, mape: metrics.mape, records: records.slice(0, 12) };
  }

  /** Keeps one record per forecast and day so later evaluations can compare it with real bookings. */
  private async recordForecast(dashboard: ForecastDashboard) {
    const demand = dashboard.demand!;
    const service = dashboard.params.serviceType === 'All' ? null : dashboard.params.serviceType;
    try {
      interface Existing { id: number }
      const existing = await this.storage.query<Existing[]>(
        `SELECT id FROM ai_demand_forecasts WHERE forecast_horizon = ? AND period_start = ? AND period_end = ?
         AND ${service ? 'service_type = ?' : 'service_type IS NULL'} AND garage IS NULL AND predicted_bookings = ?
         AND DATE(generated_at) = CURDATE() LIMIT 1`,
        [dashboard.params.horizon, dashboard.params.historyStart, dashboard.params.historyEnd, ...(service ? [service] : []), demand.totalForecast],
      );
      if (existing.length) return;
      await this.storage.insert(
        `INSERT INTO ai_demand_forecasts (forecast_horizon, period_start, period_end, service_type, garage, predicted_bookings, confidence, forecast_data, recommendations, summary_text)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
        [
          dashboard.params.horizon, dashboard.params.historyStart, dashboard.params.historyEnd, service, demand.totalForecast,
          JSON.stringify(demand.daily.map((day) => ({ date: day.date, forecast: day.forecast }))),
          JSON.stringify(dashboard.systemInsights.recommendedActions.map((item) => item.action)),
          demand.summary,
        ],
      );
    } catch (error) {
      this.logger.warn(`Forecast history was not saved: ${error instanceof Error ? error.message : error}`);
    }
  }
}
