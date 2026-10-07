/** Small, fast, seedable PRNG (mulberry32). Same seed -> same sequence, which makes every generated minute
 * reproducible: re-running a window yields identical call and event IDs, so re-ingestion is idempotent. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of the parts, used to derive a per-(account, minute) seed. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const between = (rng: Rng, min: number, max: number) => min + rng() * (max - min);

/** Knuth's algorithm; fine for the small per-minute rates we use (< 30). */
export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** Log-normal with the given median; sigma controls spread. Box-Muller for the normal draw. */
export function logNormal(rng: Rng, median: number, sigma: number): number {
  const u = Math.max(rng(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  return median * Math.exp(sigma * z);
}

export const exponential = (rng: Rng, mean: number) => -mean * Math.log(Math.max(rng(), 1e-12));

export function pickWeighted<T extends { weight: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

/** Deterministic RFC 4122 v4-shaped UUID drawn from the PRNG. */
export function uuidFrom(rng: Rng): string {
  const b = Array.from({ length: 16 }, () => Math.floor(rng() * 256));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
