/**
 * Bench-style CLI renderer for Analysis JSON.
 */

import type { Analysis, ComparisonData } from "./lib/analysis.js";

// ── ANSI codes ──

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const WHITE = "\x1b[37m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

// ── Stat metadata ──

interface StatMeta {
  type: "time" | "percent" | "count" | "bytes" | "ratio";
  polarity: "lower_better" | "higher_better" | "neutral";
  ratioLabels?: [string, string]; // [better, worse]
  verboseOnly?: boolean;
}

const STAT_META: Record<string, StatMeta> = {
  "time.p50": { type: "time", polarity: "lower_better", ratioLabels: ["faster", "slower"] },
  "time.avg": { type: "time", polarity: "lower_better", ratioLabels: ["faster", "slower"] },
  "time.cv": { type: "percent", polarity: "lower_better", ratioLabels: ["more stable", "less stable"] },
  "time.mad": { type: "time", polarity: "lower_better", ratioLabels: ["more stable", "less stable"] },
  "time.mild_outliers": { type: "count", polarity: "lower_better", ratioLabels: ["fewer outliers", "more outliers"] },
  "time.p_value": { type: "ratio", polarity: "neutral" },
  "time.is_practically_significant": { type: "count", polarity: "neutral" },
  "count": { type: "count", polarity: "higher_better", ratioLabels: ["more", "fewer"] },
  "mem.used_mb": { type: "bytes", polarity: "lower_better", ratioLabels: ["less", "more"], verboseOnly: false },
  "mem.allocs": { type: "count", polarity: "lower_better", ratioLabels: ["fewer allocs", "more allocs"], verboseOnly: false },
  "time.min": { type: "time", polarity: "lower_better", verboseOnly: true },
  "time.max": { type: "time", polarity: "lower_better", verboseOnly: true },
  "time.p10": { type: "time", polarity: "lower_better", verboseOnly: true },
  "time.p90": { type: "time", polarity: "lower_better", verboseOnly: true },
  "time.p99": { type: "time", polarity: "lower_better", verboseOnly: true },
  "time.std": { type: "time", polarity: "lower_better", verboseOnly: true },
};

const DISPLAY_ORDER = [
  "time.p50", "time.avg", "time.cv", "time.mad", "time.mild_outliers",
  "time.p_value", "time.is_practically_significant", "count",
  "mem.used_mb", "mem.allocs",
  // verbose
  "time.min", "time.max", "time.p10", "time.p90", "time.p99", "time.std",
];

// ── Value formatting (Bench-style) ──

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visualWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function pad(s: string, width: number, align: "left" | "right" = "right"): string {
  const vw = visualWidth(s);
  const needed = Math.max(0, width - vw);
  if (align === "left") return s + " ".repeat(needed);
  return " ".repeat(needed) + s;
}

const TIME_SCALES: [number, number, string][] = [
  [1e6, 1e3, "s"],
  [1e3, 1, "s"],
  [1, 1, "ms"],
  [1e-3, 1e-3, "µs"],
  [0, 1e-6, "ns"],
];

function formatTime(ms: number): string {
  const abs = Math.abs(ms);
  for (const [threshold, scale, unit] of TIME_SCALES) {
    if (abs >= threshold || threshold === 0) {
      return `${(ms / scale).toFixed(3)} ${unit}`;
    }
  }
  return `${ms.toFixed(3)} ms`;
}

function formatValue(value: number, type: string): string {
  switch (type) {
    case "time": return formatTime(value);
    case "percent": return `${value.toFixed(3)} %`;
    case "bytes": return `${value.toFixed(1)} MB`;
    case "count": return `${Math.round(value)}`;
    case "ratio": return `${value.toFixed(3)}`;
    default: return `${value}`;
  }
}

function formatDelta(delta: number, type: string): string {
  const sign = delta >= 0 ? "+" : "";
  switch (type) {
    case "time": return `${sign}${formatTime(delta)}`;
    case "percent": return `${sign}${delta.toFixed(3)} %`;
    case "bytes": return `${sign}${delta.toFixed(1)} MB`;
    case "count": return `${sign}${Math.round(delta)}`;
    default: return `${sign}${delta.toFixed(3)}`;
  }
}

function formatRatio(baselineVal: number, compVal: number, meta: StatMeta): string {
  if (compVal === 0 && baselineVal === 0) return "";
  if (compVal === 0) return "";

  const ratio = Math.max(baselineVal, compVal) / Math.min(baselineVal, compVal);
  if (!isFinite(ratio) || isNaN(ratio)) return "";

  const baselineIsBetter = meta.polarity === "lower_better"
    ? baselineVal < compVal
    : meta.polarity === "higher_better"
      ? baselineVal > compVal
      : false;

  if (!meta.ratioLabels) return "";

  const [better, worse] = meta.ratioLabels;
  const label = baselineIsBetter ? better : worse;
  const color = baselineIsBetter ? GREEN : RED;

  return `${BOLD}${color}${ratio.toFixed(2)}x ${label}${RESET}`;
}

// ── Tree rendering ──

function renderBaselineStats(
  stats: Record<string, number>,
  verbose: boolean,
): string[][] {
  const rows: string[][] = [];
  for (const key of DISPLAY_ORDER) {
    const meta = STAT_META[key];
    if (!meta) continue;
    if (meta.verboseOnly && !verbose) continue;
    if (!(key in stats)) continue;

    rows.push([
      `${CYAN}${key}:${RESET}`,
      formatValue(stats[key], meta.type),
    ]);
  }
  return rows;
}

function renderComparisonStats(
  comp: ComparisonData,
  verbose: boolean,
): string[][] {
  const rows: string[][] = [];

  for (const key of DISPLAY_ORDER) {
    const meta = STAT_META[key];
    if (!meta) continue;
    if (meta.verboseOnly && !verbose) continue;
    if (!(key in comp.stats)) continue;

    // Special handling for p_value and is_practically_significant
    if (key === "time.p_value") {
      rows.push([
        `${CYAN}${key}:${RESET}`,
        comp.significance.p_value < 0.001 ? "0.001" : comp.significance.p_value.toFixed(3),
      ]);
      continue;
    }
    if (key === "time.is_practically_significant") {
      rows.push([
        `${CYAN}${key}:${RESET}`,
        comp.significance.is_practically_significant ? "1" : "0",
      ]);
      continue;
    }

    const value = comp.stats[key];
    const delta = comp.delta[key] ?? 0;
    const ratio = formatRatio(
      comp.stats[key] - delta, // baseline value = comp - delta (since delta = baseline - comp)
      value,
      meta,
    );

    // Note: delta is baseline - comparison, but display shows comparison value
    // and delta from comparison perspective
    rows.push([
      `${CYAN}${key}:${RESET}`,
      formatValue(value, meta.type),
      formatDelta(delta, meta.type),
      ratio,
    ]);
  }

  return rows;
}

// ── Column alignment (batch across all tables) ──

function alignRows(tables: string[][][]): void {
  // Find max columns across all tables
  const maxCols = Math.max(...tables.flat().map(r => r.length));
  const colWidths = new Array(maxCols).fill(0);

  for (const table of tables) {
    for (const row of table) {
      for (let i = 0; i < row.length; i++) {
        const w = visualWidth(row[i]);
        if (w > colWidths[i]) colWidths[i] = w;
      }
    }
  }

  // Pad all rows
  for (const table of tables) {
    for (const row of table) {
      for (let i = 0; i < row.length; i++) {
        const align = i === 0 ? "left" : "right";
        row[i] = pad(row[i], colWidths[i], align);
      }
    }
  }
}

// ── Main render function ──

export function renderAnalysis(
  analysis: Analysis,
  verbose: boolean = false,
  depth: number = 0,
  maxDepth: number = 999,
): string {
  const lines: string[] = [];
  const indent = "    ".repeat(depth);

  // Node label
  lines.push(`${indent}${BOLD}${WHITE}${analysis.label}${RESET}`);

  // Collect all tables for batch alignment
  const baselineRows = renderBaselineStats(analysis.stats, verbose);
  const compTables: { name: string; rows: string[][] }[] = [];

  if (analysis.comparisons) {
    for (const [name, comp] of Object.entries(analysis.comparisons)) {
      compTables.push({ name, rows: renderComparisonStats(comp, verbose) });
    }
  }

  // Align all tables together
  const allTables = [baselineRows, ...compTables.map(t => t.rows)];
  alignRows(allTables);

  // Render baseline stats
  const treeIndent = indent + "  ";
  const hasComparisons = compTables.length > 0;
  const hasChildren = analysis.children && Object.keys(analysis.children).length > 0;

  for (let i = 0; i < baselineRows.length; i++) {
    const branch = (i < baselineRows.length - 1 || hasComparisons || hasChildren)
      ? `${GRAY}├──${RESET} ` : `${GRAY}└──${RESET} `;
    lines.push(`${treeIndent}${branch}${baselineRows[i].join("  ").trimEnd()}`);
  }

  // Render comparisons
  for (let ci = 0; ci < compTables.length; ci++) {
    const { name, rows } = compTables[ci];
    const isLastComp = ci === compTables.length - 1 && !hasChildren;
    const compBranch = isLastComp ? `${GRAY}└──${RESET} ` : `${GRAY}├──${RESET} `;
    const compCont = isLastComp ? "    " : `${GRAY}│${RESET}   `;

    lines.push(`${treeIndent}${compBranch}${BOLD}vs ${name}:${RESET}`);

    for (let i = 0; i < rows.length; i++) {
      const rowBranch = i < rows.length - 1
        ? `${GRAY}├──${RESET} ` : `${GRAY}└──${RESET} `;
      lines.push(`${treeIndent}${compCont}${rowBranch}${rows[i].join("  ").trimEnd()}`);
    }
  }

  // Render children
  if (hasChildren && depth < maxDepth) {
    const childEntries = Object.entries(analysis.children!);
    for (let i = 0; i < childEntries.length; i++) {
      const [, child] = childEntries[i];
      lines.push(renderAnalysis(child, verbose, depth + 1, maxDepth));
    }
  }

  return lines.join("\n");
}
