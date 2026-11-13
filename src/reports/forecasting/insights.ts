/**
 * Insights for the AI Insights tab.
 *
 * - `buildSystemInsights` derives insights with fixed rules from the computed
 *   forecast. They are always available and contain only verified figures.
 * - `buildFacts` is the structured forecast result handed to the LLM; the LLM
 *   interprets it but never estimates numbers itself.
 * - `groundItems` removes any LLM statement that quotes a number not present in
 *   those facts, so generated text cannot introduce invented statistics.
 */
import type { ForecastDashboard } from './forecast.types';

export type Severity = 'high' | 'medium' | 'low';
export interface InsightItem { title: string; detail: string; category: 'demand' | 'service' | 'peak' | 'operations' }
export interface ActionItem { action: string; reason: string; priority: Severity }
export interface RiskItem { risk: string; detail: string; severity: Severity }
export interface InsightSet { summary: string; keyInsights: InsightItem[]; recommendedActions: ActionItem[]; risks: RiskItem[] }

const fmtDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtRange = (start: string, end: string) => (start === end ? fmtDate(start) : `${fmtDate(start)}–${fmtDate(end)}`);
const one = (value: number) => (Math.round(value * 10) / 10).toString();

export function buildSystemInsights(d: ForecastDashboard): InsightSet {
  const empty: InsightSet = { summary: '', keyInsights: [], recommendedActions: [], risks: [] };
  const demand = d.demand;
  if (!demand) return empty;
  const keyInsights: InsightItem[] = [];
  const recommendedActions: ActionItem[] = [];
  const risks: RiskItem[] = [];
  const change = demand.previousPeriod.changePct;
  const increasing = change !== null && change >= 10;
  const decreasing = change !== null && change <= -10;

  if (change === null) {
    keyInsights.push({ category: 'demand', title: 'Demand trend unavailable', detail: `About ${demand.totalForecast} bookings are expected, but there were no bookings in the previous ${d.params.forecastDays} days to compare with.` });
  } else {
    keyInsights.push({
      category: 'demand',
      title: increasing ? 'Demand is expected to increase' : decreasing ? 'Demand is expected to decrease' : 'Demand is expected to stay steady',
      detail: `About ${demand.totalForecast} bookings are expected (${fmtRange(d.params.forecastStart, d.params.forecastEnd)}), ${one(demand.dailyAverage)} per day: ${change >= 0 ? 'up' : 'down'} ${one(Math.abs(change))}% from ${one(demand.previousPeriod.dailyAverage)} per day in the previous ${demand.previousPeriod.days} days.`,
    });
  }

  const top = d.services.mostDemanded;
  if (top) {
    const row = d.services.rows.find((item) => item.service === top)!;
    keyInsights.push({ category: 'service', title: `${top} leads service demand`, detail: `${top} is expected to account for ${one(row.forecastSharePct)}% of bookings with a recorded service type.` });
  }

  if (demand.peakWeek) {
    keyInsights.push({
      category: 'peak', title: 'Peak booking period',
      detail: `${fmtRange(demand.peakWeek.start, demand.peakWeek.end)} is the busiest stretch with about ${one(demand.peakWeek.bookings)} bookings (${one(demand.peakWeek.sharePct)}% of the period).`,
    });
  } else if (demand.peakPattern) {
    keyInsights.push({
      category: 'peak', title: `${demand.peakPattern.weekday}s are the busiest days`,
      detail: `Demand is spread evenly across the weeks; ${demand.peakPattern.weekday}s peak at about ${one(demand.peakPattern.bookings)} bookings (${demand.peakPattern.dates.slice(0, 5).map(fmtDate).join(', ')}).`,
    });
  }

  const shortages = d.resources.resources.filter((item) => item.shortage > 0);
  if (shortages.length) {
    keyInsights.push({ category: 'operations', title: 'Possible resource shortage', detail: shortages.map((item) => `${item.label}: short by ${item.shortage} on ${fmtDate(item.worstShortageDate!)}`).join('; ') + '.' });
  } else if (d.resources.status === 'insufficient-data') {
    keyInsights.push({ category: 'operations', title: 'Resource needs cannot be estimated yet', detail: d.resources.message ?? '' });
  }

  const declining = d.services.rows.filter((item) => item.trend === 'down');
  declining.forEach((item) => keyInsights.push({ category: 'service', title: `${item.service} demand is declining`, detail: `${item.service} is expected to drop to ${one(item.forecast)} bookings from ${item.previousActual} in the previous period.` }));

  const trucks = d.resources.resources.find((item) => item.key === 'trucks');
  if (trucks && trucks.shortage > 0) {
    recommendedActions.push({ priority: 'high', action: `Prepare ${trucks.shortage} additional truck${trucks.shortage === 1 ? '' : 's'} for ${fmtDate(trucks.worstShortageDate!)}.`, reason: `Up to ${trucks.peakRequired} trucks may be needed while ${trucks.usableOnPeak} are usable.` });
  } else if (increasing) {
    recommendedActions.push({ priority: 'medium', action: 'Keep spare trucks ready for the increase in bookings.', reason: `Demand is expected to rise ${one(change!)}%.` });
  }
  const crewShort = d.resources.resources.filter((item) => item.key !== 'trucks' && item.shortage > 0);
  const crewAway = d.resources.crewUnavailable.drivers + d.resources.crewUnavailable.helpers;
  if (crewShort.length || crewAway > 0 || increasing) {
    recommendedActions.push({
      priority: crewShort.length ? 'high' : 'medium',
      action: 'Review driver and helper availability and leave schedules.',
      reason: crewShort.length
        ? crewShort.map((item) => `${item.label} short by ${item.shortage}`).join('; ') + '.'
        : crewAway > 0
          ? `${d.resources.crewUnavailable.drivers} driver(s) and ${d.resources.crewUnavailable.helpers} helper(s) are currently off duty or on leave.`
          : `Demand is expected to rise ${one(change!)}%.`,
    });
  }
  declining.forEach((item) => recommendedActions.push({ priority: 'low', action: `Monitor ${item.service} bookings and consider promoting it.`, reason: `Expected to fall from ${item.previousActual} to ${one(item.forecast)} bookings.` }));
  if (demand.peakWeek) {
    recommendedActions.push({ priority: shortages.length ? 'high' : 'medium', action: `Confirm trucks and crew before the peak on ${fmtRange(demand.peakWeek.start, demand.peakWeek.end)}.`, reason: `About ${one(demand.peakWeek.bookings)} bookings are expected that week.` });
  } else if (demand.peakPattern) {
    recommendedActions.push({ priority: shortages.length ? 'high' : 'medium', action: `Plan full crews for ${demand.peakPattern.weekday}s, starting ${fmtDate(demand.peakPattern.dates[0])}.`, reason: `${demand.peakPattern.weekday}s are expected to be the busiest days, at about ${one(demand.peakPattern.bookings)} bookings each.` });
  }

  if (trucks && trucks.shortage > 0) {
    risks.push({ severity: 'high', risk: 'Insufficient vehicle availability', detail: `${trucks.shortage} truck(s) short on ${fmtDate(trucks.worstShortageDate!)}; ${d.resources.unavailableVehicles.length} vehicle(s) are under repair or maintenance.` });
  } else if (d.resources.unavailableVehicles.length) {
    risks.push({ severity: 'low', risk: 'Vehicles out of service', detail: `${d.resources.unavailableVehicles.map((v) => `${v.plateNumber} (${v.status})`).join(', ')}.` });
  }
  crewShort.forEach((item) => risks.push({ severity: 'high', risk: `${item.label} shortage`, detail: `Up to ${item.peakRequired} needed on ${fmtDate(item.worstShortageDate!)} with ${item.usableOnPeak} available.` }));
  if (increasing) risks.push({ severity: change! >= 25 ? 'high' : 'medium', risk: 'Increasing booking demand', detail: `Bookings are expected to rise ${one(change!)}% over the previous period.` });
  const busiest = d.resources.resources.reduce<null | (typeof d.resources.resources)[number]>((best, item) => (item.utilizationPct !== null && (!best || item.utilizationPct > (best.utilizationPct ?? 0)) ? item : best), null);
  if (busiest && busiest.utilizationPct !== null && busiest.utilizationPct >= 80) {
    risks.push({ severity: busiest.utilizationPct >= 100 ? 'high' : 'medium', risk: 'Scheduling pressure', detail: `On ${fmtDate(busiest.peakDate)}, ${busiest.label.toLowerCase()} are needed at ${busiest.utilizationPct}% of what is usable.` });
  }
  if (d.dataQuality.limitedHistory) risks.push({ severity: 'medium', risk: 'Limited history', detail: `The forecast learned from ${d.dataQuality.trainingDays} days and ${d.dataQuality.trainingBookings} bookings, so it may change as more bookings arrive.` });

  return { summary: demand.summary, keyInsights, recommendedActions, risks };
}

/** The structured, verified forecast result passed to the LLM. */
export function buildFacts(d: ForecastDashboard) {
  const demand = d.demand!;
  return {
    forecastPeriod: { start: d.params.forecastStart, end: d.params.forecastEnd, days: d.params.forecastDays },
    historyUsed: { start: d.dataQuality.trainingStart, end: d.params.historyEnd, days: d.dataQuality.trainingDays, bookings: d.dataQuality.trainingBookings },
    forecastMethod: d.method.label,
    demand: {
      totalForecastBookings: demand.totalForecast,
      dailyAverage: demand.dailyAverage,
      alreadyBookedInPeriod: demand.alreadyBooked,
      previousPeriodActualBookings: demand.previousPeriod.actual,
      changeVsPreviousPeriodPct: demand.previousPeriod.changePct === null ? null : Math.round(demand.previousPeriod.changePct * 10) / 10,
      demandLevel: demand.demandLevel?.level ?? null,
      peakWeek: demand.peakWeek ? { start: demand.peakWeek.start, end: demand.peakWeek.end, bookings: Math.round(demand.peakWeek.bookings * 10) / 10, sharePct: Math.round(demand.peakWeek.sharePct * 10) / 10 } : null,
      peakDay: demand.peakDay ? { date: demand.peakDay.date, bookings: Math.round(demand.peakDay.bookings * 10) / 10 } : null,
      busiestWeekday: demand.peakPattern ? { weekday: demand.peakPattern.weekday, bookingsEach: demand.peakPattern.bookings, dates: demand.peakPattern.dates.map(fmtDate) } : null,
      previousPeriodDays: demand.previousPeriod.days,
      previousPeriodDailyAverage: demand.previousPeriod.dailyAverage,
    },
    services: d.services.rows.map((row) => ({ service: row.service, forecastBookings: Math.round(row.forecast * 10) / 10, sharePct: Math.round(row.forecastSharePct * 10) / 10, previousPeriodBookings: row.previousActual, trend: row.trend })),
    bookingsWithoutServiceTypeSharePct: Math.round(d.services.unclassified.sharePct * 10) / 10,
    resources: d.resources.status === 'ok' ? d.resources.resources.map((item) => ({
      resource: item.label, neededOnBusiestDay: item.peakRequired, busiestDay: item.peakDate,
      // Without availability data, say so instead of implying zero shortage.
      ...(d.resources.availabilityError
        ? { availability: 'unknown' }
        : { usableThatDay: item.usableOnPeak, shortage: item.shortage, daysWithShortage: item.shortageDays, unavailableNow: item.unavailableNow }),
    })) : { status: d.resources.status, note: d.resources.message },
    vehiclesOutOfService: d.resources.availabilityError ? 'unknown' : d.resources.unavailableVehicles.map((v) => ({ plateNumber: v.plateNumber, status: v.status, expectedBack: v.expectedBack })),
    forecastEvaluation: d.evaluation.backtest.available
      ? { testDays: d.evaluation.backtest.testDays, maeBookingsPerDay: Math.round((d.evaluation.backtest.mae ?? 0) * 100) / 100, mapePct: d.evaluation.backtest.mape === null ? null : Math.round(d.evaluation.backtest.mape * 10) / 10 }
      : { available: false, reason: d.evaluation.backtest.reason },
  };
}

function collectNumbers(value: unknown, out: Set<number>) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    [value, Math.abs(value), Math.round(value), Math.round(Math.abs(value)), Math.round(value * 10) / 10].forEach((n) => out.add(n));
  } else if (typeof value === 'string') {
    (value.match(/\d+(?:\.\d+)?/g) ?? []).forEach((token) => out.add(Number(token)));
  } else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectNumbers(item, out));
}

export function allowedNumbers(facts: unknown): Set<number> {
  const out = new Set<number>();
  collectNumbers(facts, out);
  return out;
}

/** True when every number quoted in the text appears in the verified facts. */
export function isGrounded(text: string, allowed: Set<number>): boolean {
  const tokens = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return tokens.every((token) => {
    const value = Number(token.replace(/,/g, ''));
    for (const candidate of allowed) if (Math.abs(candidate - value) < 0.051) return true;
    return false;
  });
}

const asText = (value: unknown, max = 400) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const asSeverity = (value: unknown): Severity => (value === 'high' || value === 'low' ? value : 'medium');
const asCategory = (value: unknown): InsightItem['category'] => (['demand', 'service', 'peak', 'operations'].includes(String(value)) ? (value as InsightItem['category']) : 'demand');

/** Validates the LLM JSON and drops any statement with an unverified figure. */
export function groundItems(raw: any, allowed: Set<number>): { insights: InsightSet; removed: number } {
  let removed = 0;
  const keep = (...texts: string[]) => {
    const ok = texts.every((text) => isGrounded(text, allowed));
    if (!ok) removed += 1;
    return ok;
  };
  const keyInsights = (Array.isArray(raw?.keyInsights) ? raw.keyInsights : []).slice(0, 6)
    .map((item: any) => ({ title: asText(item?.title, 120), detail: asText(item?.detail), category: asCategory(item?.category) }))
    .filter((item: InsightItem) => item.title && keep(item.title, item.detail));
  const recommendedActions = (Array.isArray(raw?.recommendedActions) ? raw.recommendedActions : []).slice(0, 6)
    .map((item: any) => ({ action: asText(item?.action, 200), reason: asText(item?.reason), priority: asSeverity(item?.priority) }))
    .filter((item: ActionItem) => item.action && keep(item.action, item.reason));
  const risks = (Array.isArray(raw?.risks) ? raw.risks : []).slice(0, 6)
    .map((item: any) => ({ risk: asText(item?.risk, 120), detail: asText(item?.detail), severity: asSeverity(item?.severity) }))
    .filter((item: RiskItem) => item.risk && keep(item.risk, item.detail));
  let summary = asText(raw?.summary, 700);
  if (summary && !keep(summary)) summary = '';
  return { insights: { summary, keyInsights, recommendedActions, risks }, removed };
}

export const INSIGHTS_SYSTEM_PROMPT = `You are an operations analyst for WeLinc Logistics, a moving and delivery company in the Philippines.
You receive VERIFIED forecast results as JSON. Interpret them for an administrator.
Rules:
- Use ONLY numbers, dates and names that appear in the JSON. Never estimate, compute, round differently, or invent any figure, resource quantity, percentage or accuracy score.
- If something is missing or null, say it is unavailable instead of guessing.
- Recommendations are suggestions; do not claim anything has been scheduled or assigned.
- Write short, plain sentences. Dates may be written like "Dec 15".
- The summary is 3-5 sentences, one idea per sentence, each under 20 words, in this order: total and daily average, demand level and change vs. the previous period, peak day and busiest weekday, trucks and crew. Do not list every date; name the busiest weekday instead.
Respond with JSON only, in this shape:
{"summary": string,
 "keyInsights": [{"category": "demand"|"service"|"peak"|"operations", "title": string, "detail": string}],
 "recommendedActions": [{"priority": "high"|"medium"|"low", "action": string, "reason": string}],
 "risks": [{"severity": "high"|"medium"|"low", "risk": string, "detail": string}]}
Give 3-5 key insights (demand change, most demanded service, peak period, operational challenges), 3-5 actions (extra trucks when demand rises or trucks are short, review driver and helper availability, monitor declining services, prepare before the peak) and up to 4 risks (vehicle availability, driver/helper shortage, rising demand, scheduling pressure). Return empty arrays when the data does not support an item.`;
