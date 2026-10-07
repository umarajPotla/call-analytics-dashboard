/** Display helpers. All dates are shown in the ACCOUNT's time zone, never the viewer's, so everyone sees the same day. */

const nf = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number) => nf.format(Math.round(n));
export const fmtPct = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(digits)}%`;

/** YYYY-MM-DD for an instant, in a time zone. */
export function localDate(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Calendar arithmetic on YYYY-MM-DD strings (time-zone free). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

export const fmtDay = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));

export const fmtShortDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );

export function fmtTime(iso: string, tz: string, seconds = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  }).format(new Date(iso));
}

export function fmtHourLabel(iso: string, tz: string): { day: string; hour: string } {
  const d = new Date(iso);
  return {
    day: new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(d),
    hour: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }).format(d),
  };
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const fmtDuration = (sec: number | null) =>
  sec === null ? "—" : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** "America/Los_Angeles" -> "Pacific Time (PT)"-like short label, e.g. "PDT". */
export function tzShort(tz: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}
