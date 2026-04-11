/**
 * Diff tree extraction — parse the microprofiler's canonical diff flamegraph HTML
 * and extract the merged per-node CPU time tree with baseline/candidate sideValues.
 *
 * Replicates the viewer's ProcessDiffGraphNode merge logic server-side.
 */

import { DiffNode, printDiffTree } from "./terminal.js";
import { writeFileSync } from "node:fs";

// ── Types ──

interface DumpContainer {
  title: string;
  dumpInfo: {
    localGroupId: number; // 0 = baseline, 1 = candidate
    numberOfFrames: number;
  };
  topDown: TopDownNode;
}

interface TopDownNode {
  name: string;
  displayValue: number; // CPU time in ms (total across all frames in this dump)
  displayCount: number;
  children: TopDownNode[];
}

interface MergedNode {
  name: string;
  sideValues: [{ displayValue: number }, { displayValue: number }];
  children: Map<string, MergedNode>;
}

// ── Parse diff HTML ──

/**
 * Extract CPU-time dump containers from the diff flamegraph HTML.
 * The HTML embeds `source_containers_json = [JSON.parse('...'), ...]`.
 */
export function parseDiffContainers(html: string): DumpContainer[] {
  const containers: DumpContainer[] = [];

  // Each entry is JSON.parse('{...}') — extract the JSON strings
  const pattern = /JSON\.parse\('(\{[^']+)'\)/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj.title === "CPU time") {
        containers.push(obj as DumpContainer);
      }
    } catch {
      // Skip malformed entries
    }
  }

  return containers;
}

/**
 * Extract normalizedNumberOfFrames from the HTML.
 */
function parseNormalizedFrames(html: string): number {
  const m = html.match(/normalizedNumberOfFrames\s*=\s*(\d+)/);
  return m ? parseInt(m[1]) : 60;
}

// ── Merge tree (replicates ProcessDiffGraphNode) ──

function createMergedNode(name: string): MergedNode {
  return {
    name,
    sideValues: [{ displayValue: 0 }, { displayValue: 0 }],
    children: new Map(),
  };
}

function mergeNode(
  merged: MergedNode,
  input: TopDownNode,
  sideId: number,
  numberOfFrames: number,
  normalizedFrames: number,
): void {
  const scale = numberOfFrames > 0 ? normalizedFrames / numberOfFrames : 0;
  merged.sideValues[sideId].displayValue += input.displayValue * scale;

  for (const child of input.children) {
    if (!merged.children.has(child.name)) {
      merged.children.set(child.name, createMergedNode(child.name));
    }
    mergeNode(merged.children.get(child.name)!, child, sideId, numberOfFrames, normalizedFrames);
  }
}

/**
 * Merge all dump containers into a single tree with sideValues[0] (baseline)
 * and sideValues[1] (candidate) at each node.
 */
export function mergeDiffTree(containers: DumpContainer[], normalizedFrames: number): MergedNode {
  const root = createMergedNode("root");

  for (const c of containers) {
    const sideId = c.dumpInfo.localGroupId;
    const nFrames = c.dumpInfo.numberOfFrames;

    // Merge root's children (the topDown root itself is "root")
    root.sideValues[sideId].displayValue += c.topDown.displayValue * (normalizedFrames / nFrames);

    for (const child of c.topDown.children) {
      if (!root.children.has(child.name)) {
        root.children.set(child.name, createMergedNode(child.name));
      }
      mergeNode(root.children.get(child.name)!, child, sideId, nFrames, normalizedFrames);
    }
  }

  return root;
}

// ── Convert to DiffNode for terminal rendering ──

function mergedToDiffNodes(
  node: MergedNode,
  minMs: number,
  maxDepth: number,
  depth: number = 0,
): DiffNode | null {
  const baselineMs = node.sideValues[0].displayValue;
  const candidateMs = node.sideValues[1].displayValue;

  if (baselineMs < minMs && candidateMs < minMs) return null;

  // Stat child: avg (per-frame value, already normalized)
  const statChildren: DiffNode[] = [
    {
      name: "avg",
      baselineMs,
      candidateMs,
      children: [],
      isStat: true,
    },
  ];

  // Recurse into tree children
  const treeChildren: DiffNode[] = [];
  if (depth < maxDepth) {
    // Sort children by total cost descending
    const sorted = [...node.children.values()].sort((a, b) => {
      const aTotal = a.sideValues[0].displayValue + a.sideValues[1].displayValue;
      const bTotal = b.sideValues[0].displayValue + b.sideValues[1].displayValue;
      return bTotal - aTotal;
    });

    for (const child of sorted) {
      const childNode = mergedToDiffNodes(child, minMs, maxDepth, depth + 1);
      if (childNode) treeChildren.push(childNode);
    }
  }

  return {
    name: node.name,
    baselineMs,
    candidateMs,
    children: [...statChildren, ...treeChildren],
    isStat: false,
  };
}

// ── Main diff function ──

export function renderDiff(
  html: string,
  baselineCount: number,
  candidateCount: number,
  minMs: number = 0,
  maxDepth: number = 999,
  outputPath?: string,
): void {
  const containers = parseDiffContainers(html);
  if (containers.length === 0) {
    console.error("No CPU time data found in diff HTML");
    process.exit(1);
  }

  const normalizedFrames = parseNormalizedFrames(html);
  const merged = mergeDiffTree(containers, normalizedFrames);

  // Convert root's children to DiffNode list (skip root itself, show its children)
  const rootNode = mergedToDiffNodes(merged, minMs, maxDepth);
  const nodes = rootNode ? [rootNode] : [];

  const title = `Diff (${baselineCount} baseline vs ${candidateCount} candidate dumps)`;

  if (outputPath) {
    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as any;
    printDiffTree(nodes, title, minMs);
    process.stderr.write = origWrite;
    writeFileSync(outputPath, lines.join(""));
    console.error(`Output → ${outputPath}`);
  } else {
    printDiffTree(nodes, title, minMs);
  }
}
