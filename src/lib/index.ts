/**
 * MicroProfiler — typed API for Roblox MicroProfiler dump analysis.
 *
 * Wraps the WASM engine and viewer JS globals with a clean interface.
 */

import { readDump } from "../format.js";
import { initWasm, reloadWasm, silent, isInitialized } from "./engine.js";
import type { WasmMemoryConfig } from "./patch.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const G = globalThis as Record<string, any>;

// ── Types ──

export interface Frame {
  id: number;
  framestart: number;
  frameend: number;
  framestartgpu: number;
  frameendgpu: number;
  paused: number;
  incomplete: number;
  cpufreq: number;
  usedmemorymb: number;
  freememorymb: number;
  allocmsecs: number;
  allocs: number;
  freemsecs: number;
  frees: number;
  cpu_waits_for_gpu: number;
  jobs_walltime_ms: number;
  render_walltime_ms: number;
  gpu_time_ms: number;
  ts: any[];
  tt: any[];
  ti: any[];
  tl: any[];
}

export interface TimerInfo {
  name: string;
  group: number;
  id: number;
}

export interface GroupInfo {
  name: string;
}

export interface CounterInfo {
  id: number;
  parent: number;
  sibling: number;
  firstchild: number;
  level: number;
  name: string;
  value: number;
  formatted: string;
  limit: number;
  formattedlimit: string;
  format: number;
}

export interface AggregateInfo {
  Frames: number;
  Time: number;
  EmptyFrames: number[];
  EmptyFrameCount: number;
}

export interface ThreadMeta {
  tid: number;
  name: string;
}

export interface RawEvent {
  ph: "B" | "E" | "i";
  ts: number;
  tid: number;
  name: string;
  cat: string;
  timer_id: number;
  label?: string;
}

// ── MicroProfiler class ──

export interface MicroProfilerOptions {
  /** Target max WASM memory in bytes. Must be a multiple of 64KB. Default: 4GB. */
  maxMemoryBytes?: number;
}

export class MicroProfiler {
  private constructor() {}

  /** Load a dump from a file path (.raw or .html). */
  static async load(path: string, opts?: MicroProfilerOptions): Promise<MicroProfiler> {
    const rawData = readDump(path);
    return MicroProfiler.fromBytes(rawData, opts);
  }

  /** Load a dump from raw bytes (with R0FL header). */
  static async fromBytes(data: Uint8Array, opts?: MicroProfilerOptions): Promise<MicroProfiler> {
    if (isInitialized()) {
      throw new Error("MicroProfiler already initialized. Only one instance per process.");
    }
    const memoryConfig: WasmMemoryConfig | undefined = opts?.maxMemoryBytes
      ? { maxMemoryBytes: opts.maxMemoryBytes }
      : undefined;
    await initWasm(data, memoryConfig);
    return new MicroProfiler();
  }

  // ── Data access ──

  get frames(): Frame[] {
    return G.Frames;
  }

  get timers(): TimerInfo[] {
    return G.TimerInfo;
  }

  get groups(): GroupInfo[] {
    return G.GroupInfo;
  }

  get counters(): CounterInfo[] {
    return G.CounterInfo;
  }

  get aggregateInfo(): AggregateInfo {
    return G.AggregateInfo;
  }

  get platformInfo(): string {
    return G.PlatformInfo;
  }

  get generalInfo(): any {
    return G.GeneralInfo;
  }

  get threads(): ThreadMeta[] {
    const names = G.ThreadNames as string[];
    const result: ThreadMeta[] = [];
    for (let i = 0; i < names.length; i++) {
      if (names[i] && names[i].trim()) {
        result.push({ tid: i, name: names[i].trim() });
      }
    }
    return result;
  }

  get frameCount(): number {
    return this.frames?.length ?? 0;
  }

  get tickToTimeScale(): number {
    return G.g_TickToTimeScale;
  }

  // ── Per-frame helpers ──

  frameDuration(i: number): number {
    const f = this.frames[i];
    return f ? f.frameend - f.framestart : 0;
  }

  frameDurations(): number[] {
    return this.frames.map((f: Frame) => f.frameend - f.framestart);
  }

  // ── Reload ──

  async reload(path: string): Promise<void> {
    const rawData = readDump(path);
    await this.reloadBytes(rawData);
  }

  async reloadBytes(data: Uint8Array): Promise<void> {
    await reloadWasm(data);
  }

  // ── Export functions ──

  exportSummaryJSON(): string | null {
    return silent(() => this._captureExport("ExportSummaryJSON"));
  }

  exportMarkersCSV(): string | null {
    return this._captureExport("ExportMarkersCSV");
  }

  exportCountersCSV(): string | null {
    return this._captureExport("ExportCountersCSV");
  }

  private _captureExport(fnName: string): string | null {
    let captured: string | null = null;
    const origSave = G.SaveExportResult;
    G.SaveExportResult = (str: string) => { captured = str; };
    try {
      const fn = G[fnName];
      if (typeof fn === "function") fn();
    } finally {
      G.SaveExportResult = origSave;
    }
    return captured;
  }

  // ── DiffSides API ──

  initDiffSides(): void {
    G.InitDiffSides();
  }

  addToDiffSide(sideId: number, path: string): void {
    const bytes = readFileSync(path);
    const file = new File([bytes], basename(path));
    G.AddToDiffSide(sideId, file);
  }

  addBytesToDiffSide(sideId: number, bytes: Uint8Array, fileName: string): void {
    const file = new File([bytes], fileName);
    G.AddToDiffSide(sideId, file);
  }

  async exportDiffSides(sideId: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const origCliMode = G.ExportCliMode;
      G.ExportCliMode = () => {
        const result = G.g_Loader.toolsData.exportResult;
        G.g_Loader.toolsData.exportResult = null;
        G.ExportCliMode = origCliMode;
        if (result) resolve(result);
        else reject(new Error("No export result"));
      };

      const origLog = console.log;
      console.log = () => {};

      G.ExportDiffSides(sideId)
        .finally(() => { console.log = origLog; })
        .catch((e: Error) => {
          G.ExportCliMode = origCliMode;
          reject(e);
        });
    });
  }

  // ── Event extraction ──

  /** Compute absolute time offset (ms) for this dump in a multi-dump timeline. */
  absoluteOffsetMs(): number {
    const aggTime: number = this.aggregateInfo?.Time ?? 0;
    const frames = this.frames;
    if (!frames || frames.length === 0) return 0;
    const lastFrame = frames[frames.length - 1];
    return aggTime * 1000 - lastFrame.frameend;
  }

  /** Extract Begin/End/Instant events from a range of frames. */
  *extractEvents(startFrame: number = 0, endFrame?: number): Generator<RawEvent> {
    const frames = this.frames;
    const end = endFrame ?? frames.length;

    // Build timer lookup tables
    const timerInfo = this.timers;
    const groupInfo = this.groups;
    const timerNames: string[] = new Array(timerInfo.length);
    const timerCats: string[] = new Array(timerInfo.length);
    const timerIds: number[] = new Array(timerInfo.length);

    for (let i = 0; i < timerInfo.length; i++) {
      const t = timerInfo[i];
      if (!t) continue;
      timerNames[i] = t.name;
      timerCats[i] = t.group < groupInfo.length && groupInfo[t.group]
        ? groupInfo[t.group].name : "";
      timerIds[i] = t.id;
    }

    for (let fi = startFrame; fi < end && fi < frames.length; fi++) {
      const frame = frames[fi];
      if (!frame) continue;
      for (let tid = 0; tid < frame.ts.length; tid++) {
        const ts = frame.ts[tid];
        const tt = frame.tt[tid];
        const ti = frame.ti[tid];
        const tl = frame.tl[tid];
        if (!ts || ts.length === 0) continue;

        for (let i = 0; i < ts.length; i++) {
          const type = tt[i];
          if (type >= 128) continue;

          let ph: "B" | "E" | "i";
          if (type === 1) ph = "B";
          else if (type === 0) ph = "E";
          else if (type === 3) ph = "i";
          else continue;

          yield {
            ph,
            ts: Number(ts[i]),
            tid,
            name: timerNames[ti[i]] || "(unknown)",
            cat: timerCats[ti[i]] || "",
            timer_id: timerIds[ti[i]] || ti[i],
            label: tl?.[i] || undefined,
          };
        }
      }
    }
  }
}

// Re-export for direct use
export { silent, silentAsync } from "./engine.js";
export type { WasmMemoryConfig } from "./patch.js";
