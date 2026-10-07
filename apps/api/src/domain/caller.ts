/**
 * Caller numbers are personal data. We keep only a masked form for display; the raw number is never stored or
 * logged. A real system would also keep a keyed hash for "repeat caller" analytics.
 */
export function maskCallerNumber(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length === 10) return `(${national.slice(0, 3)}) ***-**${national.slice(-2)}`;
  return `+** *** ***${national.slice(-2)}`;
}
