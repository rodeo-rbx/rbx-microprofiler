/**
 * Statistical toolkit for microprofiler analysis.
 * Uses jstat for t-distribution CDF/inverse.
 */

import jstat from "jstat";

// ── Sample statistics ──

export interface SampleStats {
  n: number;
  mean: number;
  median: number;
  std: number;
  se: number;
  cv: number;   // coefficient of variation (%)
  mad: number;  // median absolute deviation
  min: number;
  max: number;
  p10: number;
  p50: number;
  p90: number;
  p99: number;
  iqr: number;
  mildOutliers: number;
  severeOutliers: number;
}

export function sampleStats(values: number[]): SampleStats {
  if (values.length === 0) {
    return { n: 0, mean: 0, median: 0, std: 0, se: 0, cv: 0, mad: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0, p99: 0, iqr: 0, mildOutliers: 0, severeOutliers: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = neumaierSum(sorted) / n;
  const median = percentile(sorted, 50);

  // Bessel's correction (n-1)
  const variance = n > 1
    ? sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);
  const cv = mean !== 0 ? (std / Math.abs(mean)) * 100 : 0;

  // MAD
  const absDevs = sorted.map(v => Math.abs(v - median));
  absDevs.sort((a, b) => a - b);
  const mad = percentile(absDevs, 50);

  // IQR + outliers
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;

  let mildOutliers = 0;
  let severeOutliers = 0;
  const mildLo = q1 - 1.5 * iqr;
  const mildHi = q3 + 1.5 * iqr;
  const severeLo = q1 - 3 * iqr;
  const severeHi = q3 + 3 * iqr;
  for (const v of sorted) {
    if (v < severeLo || v > severeHi) severeOutliers++;
    else if (v < mildLo || v > mildHi) mildOutliers++;
  }

  return {
    n,
    mean,
    median,
    std,
    se,
    cv,
    mad,
    min: sorted[0],
    max: sorted[n - 1],
    p10: percentile(sorted, 10),
    p50: median,
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    iqr,
    mildOutliers,
    severeOutliers,
  };
}

// ── Percentile (linear interpolation on pre-sorted array) ──

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Neumaier summation (numerically stable) ──

function neumaierSum(values: number[]): number {
  let sum = 0;
  let c = 0;
  for (const v of values) {
    const t = sum + v;
    if (Math.abs(sum) >= Math.abs(v)) {
      c += (sum - t) + v;
    } else {
      c += (v - t) + sum;
    }
    sum = t;
  }
  return sum + c;
}

// ── Welch's t-test ──

export interface WelchResult {
  t: number;
  df: number;
  pValue: number;
  isSignificant: boolean;
  stars: string; // "***", "**", "*", ""
}

export function welchTTest(a: SampleStats, b: SampleStats): WelchResult {
  if (a.n < 2 || b.n < 2) {
    return { t: 0, df: 0, pValue: 1, isSignificant: false, stars: "" };
  }

  const varA = a.std ** 2;
  const varB = b.std ** 2;
  const seDiff = Math.sqrt(varA / a.n + varB / b.n);

  if (seDiff === 0) {
    return { t: 0, df: a.n + b.n - 2, pValue: 1, isSignificant: false, stars: "" };
  }

  const t = (a.mean - b.mean) / seDiff;

  // Welch-Satterthwaite degrees of freedom
  const num = (varA / a.n + varB / b.n) ** 2;
  const den = (varA / a.n) ** 2 / (a.n - 1) + (varB / b.n) ** 2 / (b.n - 1);
  const df = Math.max(1, num / den);

  // Two-tailed p-value via jstat
  const pValue = 2 * (1 - jstat.studentt.cdf(Math.abs(t), df));

  let stars = "";
  if (pValue < 0.001) stars = "***";
  else if (pValue < 0.01) stars = "**";
  else if (pValue < 0.05) stars = "*";

  return {
    t,
    df,
    pValue,
    isSignificant: pValue < 0.05,
    stars,
  };
}

// ── Cohen's d effect size ──

export interface CohensDResult {
  d: number;
  interpretation: "trivial" | "small" | "medium" | "large";
}

export function cohensD(a: SampleStats, b: SampleStats): CohensDResult {
  if (a.n < 2 || b.n < 2) {
    return { d: 0, interpretation: "trivial" };
  }

  const varA = a.std ** 2;
  const varB = b.std ** 2;
  const pooledStd = Math.sqrt(
    ((a.n - 1) * varA + (b.n - 1) * varB) / (a.n + b.n - 2)
  );

  if (pooledStd === 0) return { d: 0, interpretation: "trivial" };

  const d = Math.abs(a.mean - b.mean) / pooledStd;

  let interpretation: CohensDResult["interpretation"];
  if (d < 0.2) interpretation = "trivial";
  else if (d < 0.5) interpretation = "small";
  else if (d < 0.8) interpretation = "medium";
  else interpretation = "large";

  return { d, interpretation };
}

// ── Practical significance ──

export function isPracticallySignificant(
  diff: number,
  baseline: number,
  noiseThreshold: number = 0.01,
): boolean {
  if (baseline === 0) return diff !== 0;
  return Math.abs(diff / baseline) >= noiseThreshold;
}

// ── Confidence interval of the difference ──

export interface DiffCI {
  lower: number;
  upper: number;
  margin: number;
}

export function diffConfidenceInterval(
  a: SampleStats,
  b: SampleStats,
  confidence: number = 0.95,
): DiffCI {
  if (a.n < 2 || b.n < 2) {
    return { lower: 0, upper: 0, margin: 0 };
  }

  const varA = a.std ** 2;
  const varB = b.std ** 2;
  const seDiff = Math.sqrt(varA / a.n + varB / b.n);

  const num = (varA / a.n + varB / b.n) ** 2;
  const den = (varA / a.n) ** 2 / (a.n - 1) + (varB / b.n) ** 2 / (b.n - 1);
  const df = Math.max(1, num / den);

  const alpha = 1 - confidence;
  const tCrit = jstat.studentt.inv(1 - alpha / 2, df);
  const margin = tCrit * seDiff;
  const meanDiff = a.mean - b.mean;

  return {
    lower: meanDiff - margin,
    upper: meanDiff + margin,
    margin,
  };
}
