/**
 * Diff tree — baseline vs candidate CPU time per node, as the diff flame graph
 * page shows it: each node's per-frame average across its side's dumps.
 */

import { DiffNode, printDiffTree } from "./terminal.js";
import type { AveragedNode, ContainerMerge } from "./lib/merge.js";
import { writeFileSync } from "node:fs";

// ── Pair the two sides' trees by name path ──

interface MergedNode {
  name: string;
  sideValues: [{ displayValue: number }, { displayValue: number }];
  children: Map<string, MergedNode>;
}

function createMergedNode(name: string): MergedNode {
  return {
    name,
    sideValues: [{ displayValue: 0 }, { displayValue: 0 }],
    children: new Map(),
  };
}

function addSide(merged: MergedNode, node: AveragedNode, sideId: 0 | 1): void {
  merged.sideValues[sideId].displayValue += node.value;
  for (const child of node.children) {
    if (!merged.children.has(child.name)) {
      merged.children.set(child.name, createMergedNode(child.name));
    }
    addSide(merged.children.get(child.name)!, child, sideId);
  }
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
  merge: ContainerMerge,
  minMs: number = 0,
  maxDepth: number = 999,
  outputPath?: string,
): void {
  const baseline = merge.averaged("CPU time", 0);
  const candidate = merge.averaged("CPU time", 1);
  if (!baseline || !candidate) {
    console.error("No CPU time data found in the dumps");
    process.exit(1);
  }

  const merged = createMergedNode("root");
  addSide(merged, baseline, 0);
  addSide(merged, candidate, 1);

  const rootNode = mergedToDiffNodes(merged, minMs, maxDepth);
  const nodes = rootNode ? [rootNode] : [];

  const title = `Diff (${merge.dumpCount(0)} baseline vs ${merge.dumpCount(1)} candidate dumps)`;

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
