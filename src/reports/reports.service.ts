import { Injectable } from '@nestjs/common';
import * as mysql from 'mysql2/promise';
import { MySqlService } from '../shared/mysql.service';
import { SaveReportDto } from './dto/save-report.dto';
import { SaveForecastDto } from './dto/save-forecast.dto';

/**
 * Saved reports and forecasts (MySQL). The AI Demand Forecasting calculations
 * live in ./forecasting/demand-forecast.service.ts.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly mysql: MySqlService) {}

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
      confidence: dto.confidence ?? null,
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
        dto.confidence ?? null,
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
