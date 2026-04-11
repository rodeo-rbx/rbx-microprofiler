/**
 * Bench-style ANSI tree rendering for compare output.
 *
 * Ports terminal.py: DiffNode, format_table, build_stat_rows, print_diff_tree.
 */

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

// ── Scale thresholds: [threshold_ms, scale, unit, color] ──

const SCALE_THRESHOLDS: [number, number, string, string][] = [
  [1e6, 1e3, "s", RED],
  [1e3, 1, "s", YELLOW],
  [1, 1, "ms", GREEN],
  [1e-3, 1e-3, "µs", YELLOW],
  [0, 1e-6, "ns", YELLOW],
];

// ── ANSI helpers ──

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visualWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  const vw = visualWidth(s);
  const needed = Math.max(0, width - vw);
  if (align === "right") return " ".repeat(needed) + s;
  return s + " ".repeat(needed);
}

function color(text: string, code: string): string {
  return `${code}${text}${RESET}`;
}

// ── Value formatting ──

function formatScaled(valueMs: number): [string, string, string] {
  const absVal = Math.abs(valueMs);
  for (const [threshold, scale, unit, col] of SCALE_THRESHOLDS) {
    if (absVal >= threshold || threshold === 0) {
      return [(valueMs / scale).toFixed(3), unit, col];
    }
  }
  return [valueMs.toFixed(3), "ms", GREEN];
}

function formatValueColored(valueMs: number): string {
  const [num, unit, col] = formatScaled(valueMs);
  return `${col}${num} ${unit}${RESET}`;
}

// ── Table formatter ──

function formatTable(
  rows: string[][],
  justifyLeft: Set<number>,
  justifyRight: Set<number>,
  marginRight: Map<number, number>,
): string {
  if (rows.length === 0) return "";

  const numCols = Math.max(...rows.map((r) => r.length));
  const colWidths = new Array(numCols).fill(0);

  for (const row of rows) {
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] || "";
      const w = visualWidth(cell);
      if (w > colWidths[i]) colWidths[i] = w;
    }
  }

  const lines: string[] = [];
  for (const row of rows) {
    const parts: string[] = [];
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] || "";
      const align = justifyRight.has(i) ? "right" : "left";
      const mr = marginRight.get(i) || 0;
      parts.push(pad(cell, colWidths[i], align) + " ".repeat(mr));
    }
    lines.push(parts.join("").trimEnd());
  }

  return lines.join("\n");
}

// ── Stat rows ──

export interface DiffNode {
  name: string;
  baselineMs: number;
  candidateMs: number;
  children: DiffNode[];
  isStat: boolean;
}

function buildStatRows(stats: [string, number, number][]): string {
  const rows: string[][] = [];

  for (const [name, baselineMs, candidateMs] of stats) {
    const delta = candidateMs - baselineMs;
    const dColor = delta > 0 ? RED : delta < 0 ? GREEN : "";
    const ratioLabel = delta > 0 ? "slower" : delta < 0 ? "faster" : "";

    const colName = color(`${name}:`, CYAN);
    const colBaseline = formatValueColored(baselineMs);
    const colCandidate = formatValueColored(candidateMs);

    let colDelta: string;
    if (delta === 0) {
      colDelta = color("—", DIM);
    } else {
      const sign = delta >= 0 ? "+" : "-";
      const [dNum, dUnit] = formatScaled(Math.abs(delta));
      colDelta = `${dColor}${sign}${dNum} ${dUnit}${RESET}`;
    }

    let colRatio: string;
    if (delta === 0) {
      colRatio = "";
    } else if (baselineMs > 0 && candidateMs > 0) {
      const ratio = Math.max(baselineMs, candidateMs) / Math.min(baselineMs, candidateMs);
      colRatio = `${BOLD}${dColor}${ratio.toFixed(2)}x ${ratioLabel}${RESET}`;
    } else if (baselineMs === 0 && candidateMs > 0) {
      colRatio = `${BOLD}${YELLOW}NEW${RESET}`;
    } else if (candidateMs === 0 && baselineMs > 0) {
      colRatio = `${BOLD}${DIM}REMOVED${RESET}`;
    } else {
      colRatio = "";
    }

    rows.push([colName, colBaseline, colCandidate, colDelta, colRatio]);
  }

  const formatted = formatTable(
    rows,
    new Set([0]),
    new Set([1, 2, 3, 4]),
    new Map([[0, 5], [1, 5], [2, 5], [3, 5]]),
  );

  return formatted
    .split("\n")
    .map((line) => `${GRAY}│${RESET} ${line}`)
    .join("\n");
}

// ── Tree rendering ──

function renderNode(
  node: DiffNode,
  minMs: number,
  prefix: string,
  isLast: boolean,
  output: string[],
): void {
  if (node.baselineMs < minMs && node.candidateMs < minMs) return;

  const statChildren = node.children.filter((c) => c.isStat);
  const treeChildren = node.children.filter((c) => !c.isStat);

  // Branch character
  const branch = isLast ? "└── " : "├── ";
  const continuation = isLast ? "    " : "│   ";

  // Node label
  output.push(`${prefix}${GRAY}${branch}${RESET}${BOLD}${WHITE}${node.name}${RESET}`);

  // Stat rows under continuation
  if (statChildren.length > 0) {
    const statTuples: [string, number, number][] = statChildren.map((s) => [
      s.name,
      s.baselineMs,
      s.candidateMs,
    ]);
    const statText = buildStatRows(statTuples);
    for (const line of statText.split("\n")) {
      output.push(`${prefix}${GRAY}${continuation.slice(0, -2)}${RESET}${line}`);
    }
  }

  // Recurse into tree children
  const childPrefix = prefix + (GRAY + continuation + RESET);
  // We need to use raw prefix for recursion (without ANSI in prefix calculation)
  const rawChildPrefix = prefix + continuation;
  for (let i = 0; i < treeChildren.length; i++) {
    const child = treeChildren[i];
    const childIsLast = i === treeChildren.length - 1;
    renderNode(child, minMs, rawChildPrefix, childIsLast, output);
  }
}

export function printDiffTree(
  nodes: DiffNode[],
  title: string = "",
  minMs: number = 0,
): void {
  const output: string[] = [];

  if (title) {
    output.push(`\n${BOLD}${title}${RESET}`);
  }

  for (let i = 0; i < nodes.length; i++) {
    const isLast = i === nodes.length - 1;
    renderNode(nodes[i], minMs, "", isLast, output);
  }

  process.stderr.write(output.join("\n") + "\n");
}
