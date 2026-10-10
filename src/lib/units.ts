// Byte units. Physical memory capacities are reported in GiB (2^30); file/download sizes
// published by registries are usually decimal GB (10^9). Both are shown where it matters.

export const KiB = 1024;
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const GB = 1e9;

export const gib = (n: number) => n * GiB;
export const gb = (n: number) => n * GB;
export const toGiB = (bytes: number) => bytes / GiB;
export const toGB = (bytes: number) => bytes / GB;

export interface Range {
  low: number;
  mid: number;
  high: number;
}

export const exact = (v: number): Range => ({ low: v, mid: v, high: v });
export const range = (low: number, mid: number, high: number): Range => ({ low, mid, high });
export const scaleRange = (r: Range, k: number): Range => ({ low: r.low * k, mid: r.mid * k, high: r.high * k });
export const addRanges = (...rs: Range[]): Range =>
  rs.reduce((a, r) => ({ low: a.low + r.low, mid: a.mid + r.mid, high: a.high + r.high }), exact(0));
export const isExact = (r: Range) => r.low === r.high;

function trim(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  const d = abs >= 100 ? 0 : abs >= 10 ? Math.min(1, digits) : digits;
  return n.toFixed(d);
}

/** Format bytes in GiB (default) or GB, with sensible precision. */
export function fmtBytes(bytes: number | null | undefined, unit: "GiB" | "GB" = "GiB", digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return "Unknown";
  if (unit === "GiB") {
    if (Math.abs(bytes) < GiB && bytes !== 0) return `${trim(bytes / MiB, 0)} MiB`;
    return `${trim(bytes / GiB, digits)} GiB`;
  }
  if (Math.abs(bytes) < GB && bytes !== 0) return `${trim(bytes / 1e6, 0)} MB`;
  return `${trim(bytes / GB, digits)} GB`;
}

export function fmtRange(r: Range | null | undefined, unit: "GiB" | "GB" = "GiB"): string {
  if (!r) return "Unknown";
  if (isExact(r) || Math.abs(r.high - r.low) < 0.02 * GiB) return fmtBytes(r.mid, unit);
  return `${fmtBytes(r.low, unit).replace(/ \w+$/, "")}–${fmtBytes(r.high, unit)}`;
}

export function fmtParams(b: number | null | undefined): string {
  if (b == null) return "Unknown";
  if (b < 1) return `${Math.round(b * 1000)}M`;
  return `${b >= 100 ? Math.round(b) : +b.toFixed(1)}B`;
}

export function fmtTokens(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse "3.4GB", "815MB", "1.2 TB" into bytes (decimal, as published by ollama.com). */
export function parseSizeString(s: string): number | null {
  const m = /([\d.]+)\s*(KB|MB|GB|TB|B)\b/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(n * mult[m[2].toUpperCase()]);
}

/** Parse "8b", "1.5b", "270m", "3.9B", "8x7b" style parameter labels. Returns billions. */
export function parseParamLabel(s: string): number | null {
  const t = s.trim().toLowerCase();
  const moe = /^(\d+)x([\d.]+)b$/.exec(t);
  if (moe) return null; // NxM labels are not a total parameter count (shared weights) — never multiply.
  const m = /^([\d.]+)\s*([bmk])$/.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "b" ? n : m[2] === "m" ? n / 1000 : n / 1e6;
}

/** Per-token sizes (KV cache) are KiB-scale. */
export function fmtKiB(r: Range): string {
  const k = (b: number) => (b >= 10 * KiB ? Math.round(b / KiB) : +(b / KiB).toFixed(1));
  return isExact(r) ? `${k(r.mid)} KiB` : `${k(r.low)}–${k(r.high)} KiB`;
}
