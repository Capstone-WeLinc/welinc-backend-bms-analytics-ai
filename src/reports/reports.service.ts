import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';
import { PrismaService } from '../shared/prisma.service';
import { MySqlService } from '../shared/mysql.service';
import { ForecastDto } from './dto/forecast.dto';
import { SaveReportDto } from './dto/save-report.dto';
import { SaveForecastDto } from './dto/save-forecast.dto';
import Groq from 'groq-sdk';

export interface ForecastPoint {
  label: string;
  date?: string;
  historical?: number;
  forecast?: number;
}

interface DailyCount { date: string; count: number }

export interface ForecastResult {
  predictedBookings: number;
  confidence: number | null;
  forecastData: ForecastPoint[];
  historicalData: DailyCount[];
  serviceDemand: { service: string; historical: number; forecast: number }[];
  averageVehiclesPerBooking: number | null;
  averageDriversPerBooking: number | null;
  averageHelpersPerBooking: number | null;
  expectedPeakDemand: { date: string; bookings: number } | null;
  accuracy: { historicalBookingsUsed: number; mae: number | null; mape: number | null };
  recommendations: string[];
  summaryText: string;
  explanation?: string;
}

@Injectable()
export class ReportsService {
  private groq: Groq;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly mysql: MySqlService,
  ) {
    this.groq = new Groq({
      apiKey: this.config.get<string>('GROQ_API_KEY'),
    });
  }

  async getForecast(dto: ForecastDto): Promise<ForecastResult> {
    const startDate = dto.startDate.slice(0, 10);
    const endDate = dto.endDate.slice(0, 10);

    const bookings = await this.prisma.booking.findMany({
      where: {
        date: {
          gte: startDate,
          lte: `${endDate}T23:59:59.999Z`,
        },
        ...(dto.serviceType && dto.serviceType !== 'All'
          ? { service: dto.serviceType }
          : {}),
        ...((dto.garage && dto.garage !== 'All') || (dto.vehicleId && dto.vehicleId !== 'All')
          ? { scheduledBooking: { is: {
              ...(dto.garage && dto.garage !== 'All' ? { garage: dto.garage } : {}),
              ...(dto.vehicleId && dto.vehicleId !== 'All' ? { vehicleId: dto.vehicleId } : {}),
            } } }
          : {}),
      },
      select: {
        id: true,
        service: true,
        service_type: true,
        date: true,
        amount: true,
        status: true,
        payment_status: true,
        scheduledBooking: { select: { vehicleId: true, driverId: true, helperIds: true } },
      },
    });

    const totalBookings = bookings.length;
    const totalRevenue = bookings.reduce((sum, b) => sum + this.toNumber(Number(b.amount)), 0);
    const completed = bookings.filter((b) => b.status === 'Completed').length;
    const serviceCounts: Record<string, number> = {};
    bookings.forEach((b) => {
      const key = b.service || (b as any).service_type || 'Unknown';
      serviceCounts[key] = (serviceCounts[key] || 0) + 1;
    });

    if (bookings.length === 0) {
      const fallback = this.buildFallbackForecast(dto, bookings);
      fallback.explanation = this.buildExplanation(dto, bookings, fallback.predictedBookings);
      return this.addDashboardMetrics(dto, bookings, fallback);
    }

    const prompt = `You are a demand forecasting assistant for a logistics/booking company.

Historical data (${dto.startDate} to ${dto.endDate}):
- Total bookings: ${totalBookings}
- Total revenue: ₱${totalRevenue.toLocaleString('en-PH')}
- Completed bookings: ${completed}
- Service type breakdown: ${JSON.stringify(serviceCounts)}
- Forecast horizon: ${dto.forecastHorizon}

Provide a JSON response with this exact structure:
{
  "predictedBookings": number,
  "recommendations": ["Action based only on the supplied booking and service history."],
  "summaryText": "Short summary of the forecast."
}

Ground recommendations only in the supplied history. Do not invent resource counts, capacity, confidence scores, or observations. Return an empty recommendations array when there is not enough evidence. Do not include any explanation outside the JSON.`;

    try {
      const completion = await this.groq.chat.completions.create({
        messages: [
          { role: 'system', content: 'You are a helpful forecasting assistant. Respond only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.3,
        max_tokens: 1024,
      });

      const content = completion.choices[0]?.message?.content || '{}';
      const parsed = this.parseJson(content);
      const result = this.normalizeForecast(parsed, dto.forecastHorizon);
      result.explanation = this.buildExplanation(dto, bookings, result.predictedBookings);
      return this.addDashboardMetrics(dto, bookings, result);
    } catch (error) {
      console.warn(
        '[AI Forecast] AI provider failed, using deterministic fallback:',
        error instanceof Error ? error.message : error,
      );
      const fallback = this.buildFallbackForecast(dto, bookings);
      fallback.explanation = this.buildExplanation(dto, bookings, fallback.predictedBookings);
      return this.addDashboardMetrics(dto, bookings, fallback);
    }
  }

  private toNumber(value: string | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  private parseJson(content: string): unknown {
    const match = content.match(/\{[\s\S]*\}/);
    const cleaned = (match ? match[0] : content).replace(/```json|```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error('The AI provider returned an invalid forecast response.');
    }
  }

  private normalizeForecast(data: any, horizon: string): ForecastResult {
    if (!Number.isFinite(data?.predictedBookings)) {
      throw new Error('The AI provider returned incomplete forecast metrics.');
    }

    const provided = (Array.isArray(data?.forecastData) ? data.forecastData : []).map((point: any) => {
      if (!point?.label || !Number.isFinite(point.forecast)) {
        throw new Error('The AI provider returned an invalid forecast period.');
      }
      return { label: String(point.label), forecast: Number(point.forecast) };
    });

    const forecastData = provided.length ? this.buildPeriods(provided, horizon) : [];
    const providedTotal = provided.reduce((sum: number, p: { forecast: number }) => sum + p.forecast, 0);
    const predictedBookings =
      Number.isFinite(data.predictedBookings)
        ? Number(data.predictedBookings)
        : Math.round(providedTotal);

    return {
      predictedBookings: Math.max(0, Math.round(predictedBookings)),
      confidence: null,
      forecastData,
      historicalData: [],
      serviceDemand: [],
      averageVehiclesPerBooking: null,
      averageDriversPerBooking: null,
      averageHelpersPerBooking: null,
      expectedPeakDemand: null,
      accuracy: { historicalBookingsUsed: 0, mae: null, mape: null },
      recommendations: Array.isArray(data.recommendations)
        ? data.recommendations.filter((item: unknown): item is string => typeof item === 'string' && !/\b\d+\s+(?:trucks?|drivers?|helpers?|vehicles?|teams?)\b/i.test(item))
        : [],
      summaryText: typeof data.summaryText === 'string' ? data.summaryText : '',
    };
  }

  private periodLabels(horizon: string): string[] {
    if (horizon === '7days') return Array.from({ length: 7 }, (_, i) => `Day ${i + 1}`);
    if (horizon === '30days') return ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
    if (horizon === '90days') return Array.from({ length: 90 }, (_, i) => `Day ${i + 1}`);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  }

  private addDashboardMetrics(dto: ForecastDto, bookings: any[], result: ForecastResult): ForecastResult {
    const start = new Date(`${dto.startDate.slice(0, 10)}T00:00:00.000Z`);
    const end = new Date(`${dto.endDate.slice(0, 10)}T00:00:00.000Z`);
    const dayMs = 86400000;
    const dayKey = (date: Date) => date.toISOString().slice(0, 10);
    const historicalCounts = new Map<string, number>();
    for (let date = new Date(start); date <= end; date = new Date(date.getTime() + dayMs)) {
      historicalCounts.set(dayKey(date), 0);
    }
    for (const booking of bookings) {
      const key = String(booking.date).slice(0, 10);
      if (historicalCounts.has(key)) historicalCounts.set(key, (historicalCounts.get(key) ?? 0) + 1);
    }
    const historicalData = [...historicalCounts].map(([date, count]) => ({ date, count }));
    if (bookings.length === 0) {
      return {
        ...result,
        forecastData: [],
        historicalData,
        serviceDemand: [],
        averageVehiclesPerBooking: null,
        averageDriversPerBooking: null,
        averageHelpersPerBooking: null,
        expectedPeakDemand: null,
        accuracy: { historicalBookingsUsed: 0, mae: null, mape: null },
        confidence: null,
      };
    }
    const weekdayTotals = Array(7).fill(0) as number[];
    const weekdayDays = Array(7).fill(0) as number[];
    historicalData.forEach(({ date, count }) => {
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      weekdayTotals[weekday] += count;
      weekdayDays[weekday] += 1;
    });

    const weights: number[] = [];
    const futureDates: Date[] = [];
    const horizonDays = dto.forecastHorizon === '7days' ? 7 : dto.forecastHorizon === '30days' ? 30 : 90;
    for (let offset = 1; offset <= horizonDays; offset += 1) {
      const date = new Date(end.getTime() + offset * dayMs);
      futureDates.push(date);
      const weekday = date.getUTCDay();
      weights.push(weekdayDays[weekday] ? weekdayTotals[weekday] / weekdayDays[weekday] : 0);
    }
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    const rawDailyForecast = futureDates.map((date, index) => ({
      date: dayKey(date),
      value: weightTotal > 0 ? (weights[index] / weightTotal) * result.predictedBookings : result.predictedBookings / horizonDays,
    }));
    const dailyCounts = rawDailyForecast.map((point) => Math.floor(point.value));
    let remainingBookings = result.predictedBookings - dailyCounts.reduce((sum, count) => sum + count, 0);
    const remainderOrder = rawDailyForecast.map((point, index) => ({ index, remainder: point.value - dailyCounts[index] }))
      .sort((left, right) => right.remainder - left.remainder);
    for (let i = 0; i < remainingBookings && i < remainderOrder.length; i += 1) dailyCounts[remainderOrder[i].index] += 1;
    const forecastData = rawDailyForecast.map(({ date }, index) => ({ date, label: date, forecast: dailyCounts[index] }));
    const peak = forecastData.reduce<ForecastPoint | null>((current, point) =>
      !current || (point.forecast ?? 0) > (current.forecast ?? 0) ? point : current, null);

    const serviceCounts = new Map<string, number>();
    bookings.forEach((booking) => {
      const service = booking.service || booking.service_type;
      if (service) serviceCounts.set(service, (serviceCounts.get(service) ?? 0) + 1);
    });
    const serviceTotal = [...serviceCounts.values()].reduce((sum, count) => sum + count, 0);
    const serviceDemand = [...serviceCounts].map(([service, historical]) => ({
      service,
      historical,
      forecast: serviceTotal ? (historical / serviceTotal) * result.predictedBookings : 0,
    })).sort((a, b) => b.forecast - a.forecast);
    const assignedBookings = bookings.filter((booking) => booking.scheduledBooking?.helperIds?.length > 0);
    const vehicleAssignedBookings = bookings.filter((booking) => booking.scheduledBooking?.vehicleId);
    const driverAssignedBookings = bookings.filter((booking) => booking.scheduledBooking?.driverId);
    const averageVehiclesPerBooking = vehicleAssignedBookings.length
      ? vehicleAssignedBookings.length / vehicleAssignedBookings.length
      : null;
    const averageDriversPerBooking = driverAssignedBookings.length
      ? driverAssignedBookings.length / driverAssignedBookings.length
      : null;
    const averageHelpersPerBooking = assignedBookings.length
      ? assignedBookings.reduce((sum, booking) => sum + booking.scheduledBooking.helperIds.length, 0) / assignedBookings.length
      : null;

    let mae: number | null = null;
    let mape: number | null = null;
    if (historicalData.length >= 14) {
      const training = historicalData.slice(0, -7);
      const actual = historicalData.slice(-7);
      const totals = Array(7).fill(0) as number[];
      const days = Array(7).fill(0) as number[];
      training.forEach(({ date, count }) => {
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        totals[weekday] += count;
        days[weekday] += 1;
      });
      const errors = actual.map(({ date, count }) => {
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        const predicted = days[weekday] ? totals[weekday] / days[weekday] : 0;
        return { absolute: Math.abs(count - predicted), percentage: count ? Math.abs(count - predicted) / count * 100 : null };
      });
      mae = errors.reduce((sum, error) => sum + error.absolute, 0) / errors.length;
      const percentageErrors = errors.filter((error): error is { absolute: number; percentage: number } => error.percentage !== null);
      mape = percentageErrors.length
        ? percentageErrors.reduce((sum, error) => sum + error.percentage, 0) / percentageErrors.length
        : null;
    }

    const accuracy = { historicalBookingsUsed: bookings.length, mae, mape };
    return {
      ...result,
      forecastData,
      historicalData,
      serviceDemand,
      averageVehiclesPerBooking,
      averageDriversPerBooking,
      averageHelpersPerBooking,
      expectedPeakDemand: peak ? { date: peak.date!, bookings: peak.forecast ?? 0 } : null,
      accuracy,
      confidence: mape === null ? null : Math.round(Math.max(0, Math.min(100, 100 - mape))),
      summaryText: result.explanation ?? result.summaryText,
    };
  }

  private buildPeriods(
    provided: { label: string; forecast: number }[],
    horizon: string,
  ): ForecastPoint[] {
    const labels = this.periodLabels(horizon);
    const target = labels.length;
    if (provided.length === target) {
      return provided.map((p, i) => ({ label: labels[i], forecast: p.forecast }));
    }
    return labels.map((label, i) => {
      const srcIndex = target > 1 ? Math.round((i / (target - 1)) * (provided.length - 1)) : 0;
      return { label, forecast: provided[Math.min(srcIndex, provided.length - 1)].forecast };
    });
  }

  private buildFallbackForecast(dto: ForecastDto, bookings: any[]): ForecastResult {
    const horizonDays = dto.forecastHorizon === '7days' ? 7 : dto.forecastHorizon === '30days' ? 30 : 90;
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    const windowDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
    const avgPerDay = bookings.length / windowDays;
    const predictedBookings = Math.max(0, Math.round(avgPerDay * horizonDays));
    const confidence = null;

    const labels = this.periodLabels(dto.forecastHorizon);
    const target = labels.length;
    const perPeriod = target > 0 ? predictedBookings / target : 0;
    const forecastData: ForecastPoint[] = labels.map((label) => ({ label, forecast: Math.round(perPeriod) }));
    const assigned = forecastData.reduce((sum, p) => sum + (p.forecast || 0), 0);
    const remainder = predictedBookings - assigned;
    if (forecastData.length > 0) {
      forecastData[0].forecast = (forecastData[0].forecast || 0) + remainder;
    }

    const topService = (() => {
      const counts: Record<string, number> = {};
      bookings.forEach((b) => {
        const key = b.service || (b as any).service_type || 'Unknown';
        counts[key] = (counts[key] || 0) + 1;
      });
      const entries = Object.entries(counts);
      return entries.length ? entries.sort((a, b) => b[1] - a[1])[0][0] : 'your top service';
    })();
    return {
      predictedBookings,
      confidence,
      forecastData,
      historicalData: [],
      serviceDemand: [],
      averageVehiclesPerBooking: null,
      averageDriversPerBooking: null,
      averageHelpersPerBooking: null,
      expectedPeakDemand: null,
      accuracy: { historicalBookingsUsed: 0, mae: null, mape: null },
      recommendations: bookings.length ? [`Prioritize capacity for ${topService}; it was the most requested service in the selected history.`] : [],
      summaryText: bookings.length
        ? `Estimated ${predictedBookings} bookings for the next ${horizonDays} days derived from historical demand (${bookings.length} bookings over ${windowDays} days).`
        : 'No historical bookings match the selected filters. Forecast values and accuracy metrics are unavailable.',
    };
  }

  private buildExplanation(dto: ForecastDto, bookings: any[], predicted: number): string {
    const horizonDays = dto.forecastHorizon === '7days' ? 7 : dto.forecastHorizon === '30days' ? 30 : 90;
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    const windowDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
    const count = bookings.length;
    const avgPerDay = count / windowDays;
    const serviceFilter = dto.serviceType && dto.serviceType !== 'All' ? ` for "${dto.serviceType}"` : '';
    const garageFilter = dto.garage && dto.garage !== 'All' ? ` at ${dto.garage}` : '';
    const vehicleFilter = dto.vehicleId && dto.vehicleId !== 'All' ? ` for the selected vehicle` : '';

    if (count === 0) {
      return `No bookings were found between ${dto.startDate} and ${dto.endDate}${serviceFilter}${garageFilter}${vehicleFilter}. Forecast values are unavailable until matching historical bookings exist.`;
    }
    return `Based on ${count} ${count === 1 ? 'booking' : 'bookings'} recorded between ${dto.startDate} and ${dto.endDate}${serviceFilter}${garageFilter}${vehicleFilter} — an average of ${avgPerDay.toFixed(1)} bookings/day over ${windowDays} days — the model projects ${predicted} bookings across the selected ${horizonDays}-day horizon.`;
  }

  async saveReport(dto: SaveReportDto) {
    const sql = `INSERT INTO reports (report_type, period_key, garage, kpis, series, raw_metrics)
                 VALUES (?, ?, ?, ?, ?, ?)`;
    const result = await this.mysql.insert(sql, [
      dto.reportType,
      dto.periodKey,
      dto.garage ?? null,
      JSON.stringify(dto.kpis),
      JSON.stringify(dto.series),
      dto.rawMetrics ? JSON.stringify(dto.rawMetrics) : null,
    ]);
    return { id: result.insertId, message: 'Report saved successfully' };
  }

  async saveForecast(dto: SaveForecastDto) {
    const periodKey = `${dto.forecastHorizon}:${dto.periodStart}:${dto.periodEnd}`;
    const kpis = {
      predictedBookings: dto.predictedBookings,
      confidence: dto.confidence,
      forecastHorizon: dto.forecastHorizon,
      serviceType: dto.serviceType ?? 'All',
    };
    const series = {
      forecastData: dto.forecastData,
    };
    const rawMetrics = {
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      serviceType: dto.serviceType ?? 'All',
      garage: dto.garage ?? null,
      recommendations: dto.recommendations ?? [],
      summaryText: dto.summaryText ?? '',
    };

    const sql = `INSERT INTO reports (report_type, period_key, garage, kpis, series, raw_metrics)
                 VALUES (?, ?, ?, ?, ?, ?)`;
    const result = await this.mysql.insert(sql, [
      'forecast',
      periodKey,
      dto.garage ?? null,
      JSON.stringify(kpis),
      JSON.stringify(series),
      JSON.stringify(rawMetrics),
    ]);

    await this.mysql.insert(
      `INSERT INTO ai_demand_forecasts (
        forecast_horizon, period_start, period_end, service_type, garage,
        predicted_bookings, confidence, forecast_data, recommendations, summary_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dto.forecastHorizon,
        dto.periodStart,
        dto.periodEnd,
        dto.serviceType ?? null,
        dto.garage ?? null,
        dto.predictedBookings,
        dto.confidence,
        JSON.stringify(dto.forecastData),
        JSON.stringify(dto.recommendations ?? []),
        dto.summaryText ?? null,
      ],
    );

    return { id: result.insertId, message: 'AI forecast saved successfully' };
  }

  async getSavedReports() {
    interface ReportRow extends mysql.RowDataPacket {
      id: number;
      report_type: string;
      period_key: string;
      garage: string | null;
      generated_at: string;
      kpis: string;
      series: string;
      raw_metrics: string | null;
    }

    const rows = await this.mysql.query<ReportRow[]>('SELECT * FROM reports ORDER BY generated_at DESC');

    return rows.map((row) => ({
      id: row.id,
      reportType: row.report_type,
      periodKey: row.period_key,
      garage: row.garage,
      generatedAt: row.generated_at,
      kpis: this.parseJsonSafe(row.kpis),
      series: this.parseJsonSafe(row.series),
      rawMetrics: this.parseJsonSafe(row.raw_metrics ?? '{}'),
    }));
  }

  private parseJsonSafe(value: string | object | null | undefined): unknown {
    if (value === null || value === undefined) return {};
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
}
