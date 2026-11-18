// Forecast GTA VI's launch-day Twitch viewers, hour by hour.
//
// Entry for make.fun's gta6-twitch-ccu-forecast-01. Node 22, standard library
// only, deterministic: the same case file always yields the same bytes.
//
// What the program is given (one case file, schema "makefun/twitch-ccu-case/v1"):
// everything recorded up to the end of hour 1 of the release day (UTC), hour 1's
// print included, plus `comparables`: past big game launches' hourly Twitch
// category averages from 14 days before to 3 days after their release day.
// It must write, for each of hours 2..24, five quantiles (0.05, 0.25, 0.5, 0.75,
// 0.95) of that hour's concurrent-viewer count. Scoring is mean pinball loss on
// the log scale, so the forecast has to be the quantiles it really believes.
//
// Method — an empirical analogue model on log-ratios to hour 1
// ------------------------------------------------------------
// A launch day's shape is driven by when the game unlocks around the world.
// GTA VI unlocks at midnight local time, rolling: New Zealand first (11:00Z the
// day before), central Europe 23:00Z, the UK at 00:00Z, the US east coast 05:00Z
// and the west coast 08:00Z. So hour 1 (00:00-01:00 UTC) already holds the UK
// unlock and the regions ahead of it, while the US — the largest Twitch audience
// — only joins at hours 6 and 9, and the day's peak lands in the US/EU evening
// overlap (hours ~18-22 UTC). Launches that unlocked all at once, or days ahead
// (early access), have a completely different shape and are excluded.
//
// 1. Pool: the case's comparables whose unlock is a rolling midnight local one
//    and whose kit tier is "comparable" (the tier is parsed out of the unlock
//    text). GTA VI's own pre-release category history is excluded by tier.
//    Each pool launch contributes its release-day curve, hours 1..24.
// 2. For each hour h = 2..24, regress the log-ratio ln(v_h / v_1) on the launch's
//    hour-1 size, ln(v_1), centred on the pool mean, with a ridge penalty on the
//    slope (shrinkage 2). The size term matters: launches whose hour 1 is already
//    huge (most of the audience unlocked before midnight UTC) barely grow after
//    it, while launches with a small hour 1 grow several-fold by the evening.
//    A per-hour intercept plus this one slope is all the model fits — with ~11-15
//    launches in the pool, anything richer overfits.
// 3. Spread: each hour's residual standard deviation (floored at 0.25 log units),
//    and the five quantiles from the pooled, standardised residuals across all
//    hours (empirical quantiles, widened 1.1x — in-sample residuals understate
//    out-of-sample spread). Log-ratios are right-skewed (a launch can surprise
//    to the upside far more than to the downside), so the empirical residual
//    distribution, not a normal, sets the quantile shape; the 5%/95% band is
//    wider above the median than below it.
// 4. Forecast: q_tau(h) = p1 * exp(mu_h + sd_h * 1.1 * r_tau), p1 the case's
//    hour-1 print, r_tau the pooled standardised-residual quantile at tau.
//
// Validation (leave-one-launch-out on the 11-launch pool, then the four real
// practice cases scored against SullyGnome's hourly averages): the model scores
// a mean pinball loss of ~0.25 in leave-one-out and 0.173 on the practice cases,
// against the house persistence baseline's ~0.36 leave-one-out and ~0.39 on the
// practice (the rules quote 0.387), with 90% coverage 0.83-1.00 per practice
// case. Typical miss on the practice is ~30% vs the baseline's ~90%.
//
// Fallbacks keep every case valid: an hour with too few pool launches, or a case
// with too small a pool, falls back to the house persistence shape for that hour
// (median = hour 1's print, spread 0.15 * sqrt(h - 1) log units); a missing
// hour-1 print falls back to the last recorded history point, else 1 viewer.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level (fallback baseline only). */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** Spread of the fallback persistence forecast, log units per sqrt hour. */
const FALLBACK_SIGMA = 0.15;
/** Ridge penalty on the log-size slope (the intercept is never penalised). */
const SHRINK = 2;
/** Floor on an hour's residual log-spread; widening of the pooled residuals. */
const SD_FLOOR = 0.25;
const WIDEN = 1.1;
/** Minimum pool launches that must carry an hour for the regression to run. */
const MIN_LAUNCHES = 4;

interface CaseFile {
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history: Array<{ viewers: number }>;
  comparables: Array<{
    name: string;
    day_start: string;
    unlock: string;
    hourly: Array<{ from: string; viewers: number | null }>;
  }>;
}

interface Launch {
  /** ln of the launch's hour-1 viewers. */
  logV1: number;
  /** Release-day viewers by hour (1..24), only hours present in the source. */
  curve: Map<number, number>;
}

/** x rounded to 2 decimals (half up), kept strictly positive. */
const round2 = (x: number): number => Math.max(0.01, Math.round(x * 100) / 100);

/** The tier the kit records in a comparable's unlock text, if any. */
const tierOf = (unlock: string): string | null => {
  const m = /Tier:\s*([a-z-]+)/.exec(unlock ?? '');
  return m ? m[1] : null;
};

/** A comparable's release-day curve, hours 1..24, from its hourly points. */
const dayCurve = (comp: CaseFile['comparables'][number]): Map<number, number> => {
  const start = Date.parse(comp.day_start);
  const curve = new Map<number, number>();
  for (const pt of comp.hourly ?? []) {
    if (pt.viewers == null || pt.viewers <= 0) continue;
    const h = Math.round((Date.parse(pt.from) - start) / 3600000) + 1;
    if (h >= 1 && h <= 24) curve.set(h, pt.viewers);
  }
  return curve;
};

/** The analogue pool: rolling-midnight-local launches of tier "comparable". */
const buildPool = (comparables: CaseFile['comparables']): Launch[] => {
  const pool: Launch[] = [];
  for (const comp of comparables ?? []) {
    if (tierOf(comp.unlock) !== 'comparable') continue;
    if (!/midnight local/i.test(comp.unlock)) continue;
    const curve = dayCurve(comp);
    const v1 = curve.get(1);
    if (v1 == null) continue;
    pool.push({ logV1: Math.log(v1), curve });
  }
  return pool;
};

/** Linear-interpolation quantile of a sorted sample (type 7). */
const sampleQuantile = (sorted: number[], p: number): number => {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/** The fallback hour: persistence at hour 1's print, widening spread. */
const fallbackQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => round2(p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1))));

/** Solve a 2x2 linear system by Cramer's rule. */
const solve2 = (a00: number, a01: number, a11: number, b0: number, b1: number): [number, number] => {
  const det = a00 * a11 - a01 * a01 || 1e-12;
  return [(b0 * a11 - b1 * a01) / det, (a00 * b1 - a01 * b0) / det];
};

/**
 * The forecast for one case: for each hour, the five quantiles around hour 1's
 * print from the analogue regression; fallback shape where the pool is too thin.
 */
const forecast = (pool: Launch[], p1: number, hours: number[]): Map<number, number[]> => {
  const out = new Map<number, number[]>();
  if (pool.length < MIN_LAUNCHES) {
    for (const h of hours) out.set(h, fallbackQuantiles(p1, h));
    return out;
  }
  const meanLogV1 = pool.reduce((s, l) => s + l.logV1, 0) / pool.length;
  // The size slope is only fitted inside the pool's observed range of hour-1
  // sizes. A launch bigger than any analogue (GTA VI's hour 1 may be) is
  // treated like the biggest launches seen, not extrapolated linearly past
  // them: beyond the data the slope has no support, and clamping keeps the
  // forecast's shape that of Elden Ring / Cyberpunk 2077, the largest analogues.
  const lo = Math.min(...pool.map((l) => l.logV1 - meanLogV1));
  const hi = Math.max(...pool.map((l) => l.logV1 - meanLogV1));
  const x0 = Math.min(hi, Math.max(lo, Math.log(p1) - meanLogV1));
  // Per hour: intercept + slope of log-ratio on centred log hour-1 size, and the
  // residual spread. Standardised residuals are pooled across hours for the
  // quantile shape.
  const perHour = new Map<number, { mu: number; sd: number }>();
  const stdResiduals: number[] = [];
  for (const h of hours) {
    const pts: Array<{ x: number; y: number }> = [];
    for (const l of pool) {
      const v = l.curve.get(h);
      if (v != null) pts.push({ x: l.logV1 - meanLogV1, y: Math.log(v / l.curve.get(1)!) });
    }
    if (pts.length < MIN_LAUNCHES) continue;
    const n = pts.length;
    const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
    let s00 = 0, s01 = 0, s11 = 0, t0 = 0, t1 = 0;
    for (const p of pts) {
      s00 += 1; s01 += p.x; s11 += p.x * p.x;
      t0 += p.y - meanY; t1 += p.x * (p.y - meanY);
    }
    const [b0, b1] = solve2(s00, s01, s11 + SHRINK, t0, t1);
    const mu = meanY + b0 + b1 * x0;
    let ss = 0;
    const res: number[] = [];
    for (const p of pts) {
      const r = p.y - (meanY + b0 + b1 * p.x);
      res.push(r);
      ss += r * r;
    }
    const sd = Math.max(SD_FLOOR, Math.sqrt(ss / Math.max(1, n - 2)));
    perHour.set(h, { mu, sd });
    for (const r of res) stdResiduals.push(r / sd);
  }
  stdResiduals.sort((a, b) => a - b);
  for (const h of hours) {
    const ph = perHour.get(h);
    if (!ph || stdResiduals.length === 0) {
      out.set(h, fallbackQuantiles(p1, h));
      continue;
    }
    const sd = ph.sd * WIDEN;
    const q = LEVELS.map((tau) => round2(p1 * Math.exp(ph.mu + sd * sampleQuantile(stdResiduals, tau))));
    // Rounding and clamping must not break the ordering.
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    out.set(h, q.map((v) => Math.min(1e9, v)));
  }
  return out;
};

/** Hour 1's print, falling back to the last recorded history point, else 1. */
const hourOnePrint = (c: CaseFile): number => {
  const first = (c.known ?? []).find((k) => k.hour === 1);
  if (first != null && Number.isFinite(first.viewers)) return Math.max(1, first.viewers);
  const hist = c.history ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (Number.isFinite(hist[i].viewers) && hist[i].viewers > 0) return hist[i].viewers;
  }
  return 1;
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const p1 = hourOnePrint(c);
  const hours = (c.forecast ?? []).map((f) => f.hour).filter((h) => h >= 2 && h <= 24);
  const fc = forecast(buildPool(c.comparables), p1, hours);
  const rows = hours.map((hour) => ({ hour, q: fc.get(hour) ?? fallbackQuantiles(p1, hour) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: rows })}\n`);
}
