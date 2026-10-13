/**
 * Per-dump flame graph containers, streamed one dump at a time from whichever
 * engine reads the dump's format: the legacy engine for R0FL dumps, LibMP for
 * `.gprx` and `.x.html` captures.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { dumpFormat, readDump } from "../format.js";
import { containersFromPage, type Container } from "./containers.js";
import { exportComboPage } from "./engine.js";
import { getLibMP } from "./libmp.js";

/**
 * Legacy dumps per engine export. The engine keeps every dump's containers
 * until it writes its page, so batches bound its memory and the page's size.
 */
const LEGACY_BATCH = 16;

export interface DumpRef {
  path: string;
  /** The segment of a LibMP capture that holds several. */
  segment?: number;
}

/** The dumps in these files: one per file, or one per segment of a LibMP capture with several. */
export async function listDumps(files: string[]): Promise<DumpRef[]> {
  const dumps: DumpRef[] = [];
  for (const path of files) {
    if (dumpFormat(path) === "legacy") {
      dumps.push({ path });
      continue;
    }
    const libmp = await getLibMP();
    const segments = libmp.segmentCount(new Uint8Array(readFileSync(path)), basename(path));
    if (segments === 1) dumps.push({ path });
    else for (let segment = 0; segment < segments; segment++) dumps.push({ path, segment });
  }
  return dumps;
}

/** Each dump's containers, in file order. A capture with several segments yields one dump per segment. */
export async function* dumpContainers(files: string[]): AsyncGenerator<Container[]> {
  const batch: string[] = [];
  for (const path of files) {
    if (dumpFormat(path) === "legacy") {
      batch.push(path);
      if (batch.length === LEGACY_BATCH) yield* legacyDumps(batch.splice(0));
      continue;
    }
    yield* legacyDumps(batch.splice(0));
    yield* libmpDumps(path);
  }
  yield* legacyDumps(batch.splice(0));
}

async function* legacyDumps(paths: string[]): AsyncGenerator<Container[]> {
  if (paths.length === 0) return;
  const page = await exportComboPage(paths.map((path) => ({ data: readDump(path), fileName: basename(path) })));
  // Each export leaves a WASM instance behind; collect it before the next
  // batch allocates another, or instances pile up until the GC gets to them.
  Bun.gc(true);
  const byDump: Container[][] = paths.map(() => []);
  for (const c of containersFromPage(page)) byDump[c.dumpInfo.localId]?.push(c);
  const unread = paths.filter((_, i) => byDump[i].length === 0);
  if (unread.length > 0) throw new Error(`The legacy engine couldn't read ${unread.join(", ")}`);
  yield* byDump;
}

async function* libmpDumps(path: string): AsyncGenerator<Container[]> {
  const libmp = await getLibMP();
  const bytes = new Uint8Array(readFileSync(path));
  const name = basename(path);
  const segments = libmp.segmentCount(bytes, name);
  if (segments === 1) {
    yield await libmp.containers(bytes, name);
    return;
  }
  for (let s = 0; s < segments; s++) {
    yield await libmp.containers(bytes, `${name} [segment ${s + 1}/${segments}]`, s);
  }
}
