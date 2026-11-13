import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import * as mysql from 'mysql2/promise';

dotenv.config();

const OUTPUT_CSV = path.resolve(__dirname, 'forecast-accuracy-report.csv');

interface ForecastRow extends mysql.RowDataPacket {
  id: number;
  period_start: Date | string;
  period_end: Date | string;
  service_type: string | null;
  garage: string | null;
  predicted_bookings: number;
  forecast_data: unknown;
}

interface ComparisonRecord {
  forecast_id: number;
  period_start: string;
  period_end: string;
  predicted: number;
  actual: number;
  error: number;
  abs_error: number;
  ape: number | null;
}

function toDateStr(value: Date | string): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function isFilterable(value: string | null | undefined): value is string {
  return !!value && value.trim() !== '' && value.trim().toLowerCase() !== 'all';
}

async function main() {
  const mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: process.env.MYSQL_DATABASE || 'welinc',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
  });

  const pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pgPool) });

  try {
    const [forecasts] = await mysqlPool.query<ForecastRow[]>(
      `SELECT id, period_start, period_end, service_type, garage, predicted_bookings, forecast_data
       FROM ai_demand_forecasts
       ORDER BY period_start ASC, id ASC`,
    );

    if (!forecasts.length) {
      console.warn('[Evaluate] No forecasts found in ai_demand_forecasts. Writing header-only CSV.');
      writeCsv([]);
      return;
    }

    const records: ComparisonRecord[] = [];
    let maeSum = 0;
    let mapeSum = 0;
    let mapeCount = 0;
    let zeroActual = 0;

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    for (const f of forecasts) {
      // period_start/period_end hold the HISTORY the forecast learned from; the
      // forecast itself covers the dates in forecast_data, so compare against those.
      let data: unknown = f.forecast_data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = []; } }
      const dates = (Array.isArray(data) ? data : []).map((point: any) => String(point?.date ?? '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if (!dates.length || dates[dates.length - 1] >= today) continue; // no dated forecast, or its period has not finished
      const periodStart = dates[0];
      const periodEnd = dates[dates.length - 1];
      const predicted = Number(f.predicted_bookings) || 0;

      const where: any = {
        deleted_at: null,
        NOT: { status: { contains: 'cancel', mode: 'insensitive' } },
        date: {
          gte: periodStart,
          lte: `${periodEnd}T23:59:59.999Z`,
        },
      };
      if (isFilterable(f.service_type)) where.service = f.service_type;
      if (isFilterable(f.garage)) where.scheduledBooking = { is: { garage: f.garage } };

      const actual = await prisma.booking.count({ where });

      const error = predicted - actual;
      const absError = Math.abs(error);
      const ape = actual > 0 ? (absError / actual) * 100 : null;

      records.push({
        forecast_id: f.id,
        period_start: periodStart,
        period_end: periodEnd,
        predicted,
        actual,
        error,
        abs_error: absError,
        ape,
      });

      maeSum += absError;
      if (ape !== null) {
        mapeSum += ape;
        mapeCount += 1;
      } else {
        zeroActual += 1;
      }
    }

    writeCsv(records);

    const count = records.length;
    const mae = count ? maeSum / count : 0;
    const mape = mapeCount ? mapeSum / mapeCount : 0;

    console.log('\n===== AI Demand Forecast Accuracy (Backtesting) =====');
    console.log(`Forecasts evaluated : ${count}`);
    console.log(`MAE  (Mean Abs Error): ${mae.toFixed(2)} bookings`);
    console.log(`MAPE (Mean Abs % Err): ${mape.toFixed(2)}%  (over ${mapeCount} period(s) with actual > 0)`);
    if (zeroActual) console.log(`Note: ${zeroActual} period(s) had 0 actual bookings and were excluded from MAPE.`);
    console.log(`CSV written to: ${OUTPUT_CSV}`);
    console.log('=====================================================\n');
  } finally {
    await mysqlPool.end();
    await prisma.$disconnect();
    await pgPool.end();
  }
}

function writeCsv(records: ComparisonRecord[]) {
  const header = [
    'forecast_id',
    'period_start',
    'period_end',
    'predicted',
    'actual',
    'error',
    'abs_error',
    'ape',
  ];
  const lines = [header.join(',')];
  for (const r of records) {
    lines.push(
      [
        r.forecast_id,
        r.period_start,
        r.period_end,
        r.predicted,
        r.actual,
        r.error,
        r.abs_error,
        r.ape === null ? '' : r.ape.toFixed(2),
      ].join(','),
    );
  }
  fs.writeFileSync(OUTPUT_CSV, lines.join('\n') + '\n', 'utf8');
}

main().catch((err) => {
  console.error('[Evaluate] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
