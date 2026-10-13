/**
 * MicroProfiler — typed API for Roblox MicroProfiler dump analysis.
 *
 * Wraps the legacy WASM engine, LibMP, and their viewer globals with a clean interface.
 */

import { dumpFormat, readDump } from "../format.js";
import { initWasm, reloadWasm, silent, isInitialized } from "./engine.js";
import { getLibMP, type LibMPHost } from "./libmp.js";
import type { WasmMemoryConfig } from "./patch.js";
import { readFileSync } from "node:fs";

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
  /** Target max WASM memory in bytes for legacy dumps. Must be a multiple of 64KB. Default: 4GB. */
  maxMemoryBytes?: number;
}

/**
 * One loaded dump at a time, from either engine: legacy R0FL dumps (`.raw`,
 * legacy `.html`) load into the legacy engine on the process globals, `.gprx`
 * and `.x.html` captures into LibMP's viewer. Both expose the same viewer
 * globals and exports. The legacy engine is process-wide, so use one
 * MicroProfiler at a time.
 */
export class MicroProfiler {
  private G: Record<string, any> = globalThis;
  /** LibMP's host while a LibMP capture is loaded. */
  private libmp: LibMPHost | null = null;

  private constructor(private readonly opts?: MicroProfilerOptions) {}

  /** Load a dump from a file path (.raw, .html, .gprx or .x.html); `segment` picks a LibMP capture's segment. */
  static async load(path: string, opts?: MicroProfilerOptions, segment?: number): Promise<MicroProfiler> {
    const mp = new MicroProfiler(opts);
    await mp.reload(path, segment);
    return mp;
  }

  /** Load a legacy dump from raw bytes (with R0FL header). */
  static async fromBytes(data: Uint8Array, opts?: MicroProfilerOptions): Promise<MicroProfiler> {
    const mp = new MicroProfiler(opts);
    await mp.reloadBytes(data);
    return mp;
  }

  // ── Data access ──

  get frames(): Frame[] {
    return this.G.Frames;
  }

  get timers(): TimerInfo[] {
    return this.G.TimerInfo;
  }

  get groups(): GroupInfo[] {
    return this.G.GroupInfo;
  }

  get counters(): CounterInfo[] {
    return this.G.CounterInfo;
  }

  get aggregateInfo(): AggregateInfo {
    return this.G.AggregateInfo;
  }

  get platformInfo(): string {
    return this.G.PlatformInfo;
  }

  get generalInfo(): any {
    return this.G.GeneralInfo;
  }

  get threads(): ThreadMeta[] {
    const names = this.G.ThreadNames as string[];
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
    return this.G.g_TickToTimeScale;
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

  async reload(path: string, segment?: number): Promise<void> {
    if (dumpFormat(path) === "legacy") {
      await this.reloadBytes(readDump(path));
      return;
    }
    this.libmp = await getLibMP();
    this.G = await this.libmp.loadViewer(new Uint8Array(readFileSync(path)), segment);
  }

  /** Load a legacy dump from raw bytes (with R0FL header). */
  async reloadBytes(data: Uint8Array): Promise<void> {
    if (isInitialized()) {
      await reloadWasm(data);
    } else {
      const memoryConfig: WasmMemoryConfig | undefined = this.opts?.maxMemoryBytes
        ? { maxMemoryBytes: this.opts.maxMemoryBytes }
        : undefined;
      await initWasm(data, memoryConfig);
    }
    this.G = globalThis;
    this.libmp = null;
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
    if (this.libmp) return this.libmp.export(fnName);
    let captured: string | null = null;
    const origSave = this.G.SaveExportResult;
    this.G.SaveExportResult = (str: string) => { captured = str; };
    try {
      const fn = this.G[fnName];
      if (typeof fn === "function") fn();
    } finally {
      this.G.SaveExportResult = origSave;
    }
    return captured;
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
