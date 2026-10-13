/**
 * Streaming merge of flame graph containers — folds one dump's containers at
 * a time into one tree per metric per side, so memory and output size depend
 * on the number of distinct call paths, not the number of dumps.
 *
 * Mirrors the flame graph page's own merge (ProcessDiffGraphNode,
 * NormalizeGraphValues): nodes are keyed by their "|"-joined name path, keep
 * the attributes of the dump that first had them, and each dump's values are
 * scaled to one frame before summing; a side's sums are then scaled by one
 * over its dump count. The page, handed the merged containers as one-frame
 * dumps, computes exactly the values it computes from the dumps themselves.
 */

import type { Container, DumpInfo, FlameNode } from "./containers.js";

interface MergedNode {
  name: string;
  color: string;
  groupName: string;
  timerIndex: number;
  displayValue: number;
  displayCount: number;
  children: MergedNode[];
}

/** The page's NormalizeByNumberOfFrames, with normalizedNumberOfFrames = 1. */
function perFrame(value: number, frames: number): number {
  return frames > 0 ? value * (1 / frames) : 0;
}

class SideTree {
  root: MergedNode | null = null;
  dumps = 0;
  private nodes = new Map<string, MergedNode>();

  add(topDown: FlameNode, frames: number): void {
    this.root = this.visit(topDown, topDown.name, frames).node;
    this.dumps++;
  }

  private visit(input: FlameNode, hash: string, frames: number): { node: MergedNode; isNew: boolean } {
    let node = this.nodes.get(hash);
    const isNew = !node;
    if (!node) {
      node = {
        name: input.name,
        color: input.color,
        groupName: input.groupName,
        timerIndex: input.timerIndex,
        displayValue: 0,
        displayCount: 0,
        children: [],
      };
      this.nodes.set(hash, node);
    }
    node.displayValue += perFrame(input.displayValue, frames);
    node.displayCount += perFrame(input.displayCount, frames);
    for (const child of input.children) {
      const result = this.visit(child, hash + "|" + child.name, frames);
      if (result.isNew) node.children.push(result.node);
    }
    return { node, isNew };
  }
}

/** A merged node's per-frame average across its side's dumps. */
export interface AveragedNode {
  name: string;
  value: number;
  children: AveragedNode[];
}

interface Metric {
  title: string;
  shortName: string;
  units: string;
  sides: [SideTree, SideTree];
}

export class ContainerMerge {
  /** One entry per dump, in the order added, for the page's header. */
  readonly dumps: DumpInfo[] = [];
  private metrics = new Map<string, Metric>();
  private firstDump: Container[] | null = null;

  /** Add one dump's containers to a side (0 = baseline, 1 = candidate). */
  add(containers: Container[], side: 0 | 1): void {
    if (containers.length === 0) return;
    const localId = this.dumps.length;
    this.dumps.push({ ...containers[0].dumpInfo, localId, localGroupId: side });
    if (localId === 0) this.firstDump = containers;
    else this.firstDump = null;

    for (const c of containers) {
      let metric = this.metrics.get(c.title);
      if (!metric) {
        metric = { title: c.title, shortName: c.shortName, units: c.units, sides: [new SideTree(), new SideTree()] };
        this.metrics.set(c.title, metric);
      }
      metric.sides[side].add(c.topDown, c.dumpInfo.numberOfFrames);
    }
  }

  dumpCount(side: 0 | 1): number {
    return this.dumps.filter((d) => d.localGroupId === side).length;
  }

  /**
   * The containers for the flame graph page: a single dump's own containers,
   * or, for several, one merged container per metric per side, each a
   * one-frame dump holding the side's per-frame averages.
   */
  pageContainers(): Container[] {
    if (this.firstDump) return this.firstDump;
    const out: Container[] = [];
    for (const side of [0, 1] as const) {
      for (const m of this.metrics.values()) {
        const tree = m.sides[side];
        if (!tree.root) continue;
        const scale = 1 / tree.dumps;
        out.push({
          title: m.title,
          shortName: m.shortName,
          units: m.units,
          dumpInfo: {
            fileName: "",
            localId: side,
            localGroupId: side,
            numberOfFrames: 1,
            utcCaptureTime: 0,
            placeId: "0",
          },
          topDown: toFlameNode(tree.root, scale),
        });
      }
    }
    return out;
  }

  /** A side's per-frame averages for one metric, or null if it has none. */
  averaged(title: string, side: 0 | 1): AveragedNode | null {
    const tree = this.metrics.get(title)?.sides[side];
    if (!tree?.root) return null;
    const scale = 1 / tree.dumps;
    const convert = (n: MergedNode): AveragedNode => ({
      name: n.name,
      value: n.displayValue * scale,
      children: n.children.map(convert),
    });
    return convert(tree.root);
  }
}

function toFlameNode(n: MergedNode, scale: number): FlameNode {
  const displayValue = n.displayValue * scale;
  return {
    name: n.name,
    displayValue,
    displayCount: n.displayCount * scale,
    value: displayValue,
    color: n.color,
    groupName: n.groupName,
    timerIndex: n.timerIndex,
    children: n.children.map((c) => toFlameNode(c, scale)),
  };
}
