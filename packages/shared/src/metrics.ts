/**
 * Metric definitions shared by the API (which computes them) and the web app
 * (which explains them in tooltips). One place, so the two can never disagree.
 * See docs/DESIGN.md §4.
 */

export type StatusCounts = {
  ringing: number;
  connected: number;
  missed: number;
  converted: number;
};

/** Below this many resolved calls a rate is flagged as low-volume in the UI and ignored by AI insights. */
export const LOW_VOLUME_THRESHOLD = 30;

/** Conversions can arrive up to this long after the call (A2); calls younger than this may still convert. */
export const LATE_CONVERSION_HOURS = 72;

export const emptyCounts = (): StatusCounts => ({ ringing: 0, connected: 0, missed: 0, converted: 0 });

export const totalCalls = (c: StatusCounts): number => c.ringing + c.connected + c.missed + c.converted;

/** Calls with a known outcome. In-progress (ringing) calls are excluded so live calls don't drag rates down. */
export const resolvedCalls = (c: StatusCounts): number => c.connected + c.missed + c.converted;

export const answeredCalls = (c: StatusCounts): number => c.connected + c.converted;

/** null means "no data", rendered as an em dash, never as 0% or NaN. */
const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/** Primary conversion rate: converted ÷ resolved calls (marketing view: a missed call is a lost opportunity). */
export const conversionRate = (c: StatusCounts): number | null => ratio(c.converted, resolvedCalls(c));

/** Secondary conversion rate: converted ÷ answered calls (sales-effectiveness view). */
export const conversionRateOfAnswered = (c: StatusCounts): number | null =>
  ratio(c.converted, answeredCalls(c));

export const answerRate = (c: StatusCounts): number | null => ratio(answeredCalls(c), resolvedCalls(c));

export const isLowVolume = (c: StatusCounts): boolean => resolvedCalls(c) < LOW_VOLUME_THRESHOLD;

export const addCounts = (a: StatusCounts, b: StatusCounts): StatusCounts => ({
  ringing: a.ringing + b.ringing,
  connected: a.connected + b.connected,
  missed: a.missed + b.missed,
  converted: a.converted + b.converted,
});
