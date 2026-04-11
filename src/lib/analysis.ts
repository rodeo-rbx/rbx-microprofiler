/**
 * Analysis pipeline — extract per-dump per-node samples from the WASM's
 * canonical diff flamegraph data, compute statistics, compare baseline
 * vs candidates, produce Analysis JSON.
 *
 * Uses the WASM's ExportDiffSides to get canonical per-node CPU times
 * (with proper cross-thread causal attribution). Each dump contributes
 * one sample per node (per-frame average = displayValue / numberOfFrames).
 */

import { MicroProfiler } from "./index.js";
import { parseDiffContainers } from "../diff.js";
import {
  sampleStats,
  welchTTest,
  cohensD,
  isPracticallySignificant,
  type SampleStats,
} from "./stats.js";

// ── Analysis types (canonical JSON representation) ──

export interface Analysis {
  label: string;
  stats: Record<string, number>;
  comparisons?: Record<string, ComparisonData>;
  children?: Record<string, Analysis>;
}

export interface ComparisonData {
  stats: Record<string, number>;
  delta: Record<string, number>;
  significance: {
    t_statistic: number;
    p_value: number;
    cohens_d: number;
    cohens_d_interpretation: string;
    is_significant: boolean;
    is_practically_significant: boolean;
    stars: string;
  };
}

// ── Internal sample tree ──

interface SampleNode {
  samples: number[]; // per-dump per-frame-average values
  children: Map<string, SampleNode>;
}

function createSampleNode(): SampleNode {
  return { samples: [], children: new Map() };
}

// ── Extract per-dump samples from WASM combo HTML ──

interface TopDownNode {
  name: string;
  displayValue: number;
  displayCount: number;
  children: TopDownNode[];
}

/**
 * Walk a dump's topDown tree and collect per-frame-average values
 * into the sample tree (one sample per dump per node).
 */
function collectSamples(
  sampleNode: SampleNode,
  topDown: TopDownNode,
  numberOfFrames: number,
): void {
  const perFrameAvg = numberOfFrames > 0 ? topDown.displayValue / numberOfFrames : 0;
  sampleNode.samples.push(perFrameAvg);

  for (const child of topDown.children) {
    if (!sampleNode.children.has(child.name)) {
      sampleNode.children.set(child.name, createSampleNode());
    }
    collectSamples(sampleNode.children.get(child.name)!, child, numberOfFrames);
  }
}

/**
 * Generate a single-side combo flamegraph HTML from dump files via the WASM,
 * then parse the per-dump topDown trees.
 */
async function extractWasmSamples(
  mp: MicroProfiler,
  files: string[],
): Promise<SampleNode> {
  // Load all files into DiffSides side 0
  mp.initDiffSides();
  for (let i = 1; i < files.length; i++) {
    mp.addToDiffSide(0, files[i]);
  }

  // Export single-side combo → HTML
  const html = await mp.exportDiffSides(0);

  // Parse CPU time containers
  const containers = parseDiffContainers(html);
  if (containers.length === 0) {
    throw new Error("No CPU time data found in combo HTML");
  }

  // Build sample tree — one sample per dump per node
  const root = createSampleNode();
  for (const c of containers) {
    const nFrames = c.dumpInfo.numberOfFrames;
    collectSamples(root, c.topDown, nFrames);
  }

  return root;
}

// ── Build stats record from samples ──

function buildStats(node: SampleNode): Record<string, number> {
  const stats = sampleStats(node.samples);
  return {
    "count": stats.n,
    "time.p50": stats.p50,
    "time.avg": stats.mean,
    "time.cv": stats.cv,
    "time.mad": stats.mad,
    "time.mild_outliers": stats.mildOutliers,
    "time.min": stats.min,
    "time.max": stats.max,
    "time.p10": stats.p10,
    "time.p90": stats.p90,
    "time.p99": stats.p99,
    "time.std": stats.std,
  };
}

// ── Compare two sample trees ──

function compareNodes(
  baseline: SampleNode,
  candidate: SampleNode,
  noiseThreshold: number,
): ComparisonData {
  const bStats = sampleStats(baseline.samples);
  const cStats = sampleStats(candidate.samples);
  const tTest = welchTTest(bStats, cStats);
  const effect = cohensD(bStats, cStats);
  const diff = bStats.mean - cStats.mean;
  const practical = isPracticallySignificant(diff, cStats.mean, noiseThreshold);

  const candidateStatsRecord = buildStats(candidate);
  const baselineStatsRecord = buildStats(baseline);

  const delta: Record<string, number> = {};
  for (const key of Object.keys(candidateStatsRecord)) {
    delta[key] = (baselineStatsRecord[key] ?? 0) - (candidateStatsRecord[key] ?? 0);
  }

  return {
    stats: candidateStatsRecord,
    delta,
    significance: {
      t_statistic: tTest.t,
      p_value: tTest.pValue,
      cohens_d: effect.d,
      cohens_d_interpretation: effect.interpretation,
      is_significant: tTest.isSignificant,
      is_practically_significant: tTest.isSignificant && practical,
      stars: tTest.stars,
    },
  };
}

// ── Recursive tree → Analysis conversion ──

function sampleTreeToAnalysis(
  label: string,
  baseline: SampleNode,
  candidates: Map<string, SampleNode>,
  noiseThreshold: number,
  maxDepth: number,
  depth: number = 0,
): Analysis {
  const stats = buildStats(baseline);

  const comparisons: Record<string, ComparisonData> = {};
  for (const [name, candidateNode] of candidates) {
    comparisons[name] = compareNodes(baseline, candidateNode, noiseThreshold);
  }

  let children: Record<string, Analysis> | undefined;
  if (depth < maxDepth) {
    const allChildNames = new Set(baseline.children.keys());
    for (const [, cNode] of candidates) {
      for (const name of cNode.children.keys()) allChildNames.add(name);
    }

    if (allChildNames.size > 0) {
      children = {};
      const sorted = [...allChildNames].sort((a, b) => {
        const aAvg = baseline.children.get(a)?.samples ?? [];
        const bAvg = baseline.children.get(b)?.samples ?? [];
        const aMean = aAvg.length > 0 ? aAvg.reduce((s, v) => s + v, 0) / aAvg.length : 0;
        const bMean = bAvg.length > 0 ? bAvg.reduce((s, v) => s + v, 0) / bAvg.length : 0;
        return bMean - aMean;
      });

      for (const childName of sorted) {
        const bChild = baseline.children.get(childName) || createSampleNode();
        const cChildren = new Map<string, SampleNode>();
        for (const [candName, candNode] of candidates) {
          cChildren.set(candName, candNode.children.get(childName) || createSampleNode());
        }
        children[childName] = sampleTreeToAnalysis(
          childName, bChild, cChildren, noiseThreshold, maxDepth, depth + 1
        );
      }
    }
  }

  return {
    label,
    stats,
    comparisons: Object.keys(comparisons).length > 0 ? comparisons : undefined,
    children,
  };
}

// ── Public API ──

export interface AnalyzeOptions {
  noiseThreshold?: number;
  maxDepth?: number;
}

/**
 * Build Analysis JSON from baseline and candidate dump files.
 * Uses the WASM's canonical diff flamegraph data for per-node values.
 */
export async function buildAnalysis(
  baselineFiles: string[],
  candidates: Map<string, string[]>,
  options: AnalyzeOptions = {},
): Promise<Analysis> {
  const noiseThreshold = options.noiseThreshold ?? 0.01;
  const maxDepth = options.maxDepth ?? 999;

  // Load engine with first baseline file
  const mp = await MicroProfiler.load(baselineFiles[0]);

  // Extract baseline samples via WASM combo
  console.error(`Processing baseline (${baselineFiles.length} dumps)...`);
  const baselineSamples = await extractWasmSamples(mp, baselineFiles);

  // Extract each candidate's samples
  const candidateSamples = new Map<string, SampleNode>();
  for (const [name, files] of candidates) {
    console.error(`Processing candidate: ${name} (${files.length} dumps)...`);
    // Reload engine with first candidate file, then extract via WASM combo
    await mp.reload(files[0]);
    const samples = await extractWasmSamples(mp, files);
    candidateSamples.set(name, samples);
  }

  console.error("Building analysis...");
  return sampleTreeToAnalysis(
    "root",
    baselineSamples,
    candidateSamples,
    noiseThreshold,
    maxDepth,
  );
}
