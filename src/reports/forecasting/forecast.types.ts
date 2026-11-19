import type { Backtest, ForecastHorizon, ForecastMethod, ServiceType } from './forecast-engine';
import type { InsightSet } from './insights';
import type { ResourcePlan } from './resource-planner';

export interface SavedForecastEvaluation {
  available: boolean;
  reason?: string;
  evaluatedCount: number;
  mae: number | null;
  mape: number | null;
  records: { id: number; generatedAt: string; horizon: string; targetStart: string; targetEnd: string; predicted: number; actual: number; absError: number; ape: number | null }[];
}

/** Everything the four AI Demand Forecasting tabs display, computed in one request. */
export interface ForecastDashboard {
  generatedAt: string;
  params: {
    historyStart: string; historyEnd: string; horizon: ForecastHorizon; forecastStart: string; forecastEnd: string; forecastDays: number;
    serviceType: string; vehicleId: string;
  };
  method: { name: ForecastMethod; label: string; description: string; fallbackReason: string | null; halfLifeDays: number };
  dataQuality: {
    historicalBookings: number; cancelledExcluded: number; trainingStart: string | null; trainingDays: number; trainingBookings: number;
    limitedHistory: boolean; note: string | null;
  };
  demand: null | {
    totalForecast: number;
    dailyAverage: number;
    alreadyBooked: number;
    /** The same number of days just before the history end (shorter when history is shorter); compared per day. */
    previousPeriod: { start: string; end: string; days: number; actual: number; dailyAverage: number; changePct: number | null };
    demandLevel: { level: 'High' | 'Moderate' | 'Low'; ratio: number; historicalDailyAverage: number } | null;
    peakDay: { date: string; bookings: number } | null;
    /** Null when demand is spread evenly across weeks (no 7-day window stands out). */
    peakWeek: { start: string; end: string; bookings: number; sharePct: number } | null;
    /** Busiest weekday in the forecast and the dates it falls on. */
    peakPattern: { weekday: string; bookings: number; dates: string[] } | null;
    daily: { date: string; forecast: number; alreadyBooked: number }[];
    history: { date: string; actual: number }[];
    weekly: { start: string; end: string; days: number; actual: number | null; forecast: number | null }[];
    monthly: { month: string; actual: number | null; forecast: number | null; partial: boolean }[];
    summary: string;
  };
  evaluation: { backtest: Backtest; savedForecasts: SavedForecastEvaluation };
  services: {
    rows: { service: ServiceType; historical: number; previousActual: number; forecast: number; forecastSharePct: number; changePct: number | null; trend: 'up' | 'down' | 'flat' | 'new' | 'none' }[];
    unclassified: { historical: number; forecast: number; sharePct: number; examples: string[] };
    totalHistoricalMapped: number;
    totalForecastMapped: number;
    previousMapped: number;
    growthPct: number | null;
    mostDemanded: ServiceType | null;
    leastDemanded: ServiceType | null;
  };
  resources: ResourcePlan;
  systemInsights: InsightSet;
}

export interface AiInsightsResponse {
  status: 'ok' | 'unavailable' | 'empty';
  model: string | null;
  generatedAt: string;
  insights: InsightSet | null;
  removedUnverified: number;
  message: string | null;
}
