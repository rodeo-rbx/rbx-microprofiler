/**
 * LibMP host — Roblox's LibMP 1.1 (vendor/libmp) for `.gprx` and `.x.html`
 * captures: its tools build each capture's flame graph containers and render
 * the flame graph page, and its viewer, run headless, provides the same
 * globals (Frames, TimerInfo, ...) and exports (summary, CSV) as the legacy
 * engine's viewer. Those globals share their names with the legacy viewer's,
 * which lives on the process globals, so LibMP runs in a vm context of its own.
 */

import vm from "node:vm";
import { createRequire } from "node:module";
import libmpJs from "../../vendor/libmp/libmp.js" with { type: "text" };
import toolsJs from "../../vendor/libmp/tools.js" with { type: "text" };
import viewerJs from "../../vendor/libmp/viewer.js" with { type: "text" };
import { containersFromPage, type Container } from "./containers.js";

const COMBO_EXPORT = "ExportFramegraphComboDiff";
const HTML_OPEN = [0x3c, 0x21, 0x2d, 0x2d]; // <!--
const HTML_CLOSE = [0x2d, 0x2d, 0x3e]; // -->

/** LibMP's container formats (LibMP.Enums.ContainerFormat). */
const CONTAINER_FORMATS = { raw: 0, compressed: 1, "compressed-ascii": 2, "compressed-html": 3 } as const;
export type ConvertFormat = keyof typeof CONTAINER_FORMATS;

/** Where the `.x.html` files Studio writes load LibMP 1.1's viewer from. */
const VIEWER_ASSETS = "https://assets.create.roblox.com/assets/scripts/libmp/10072026/";

/** A `.x.html` capture's GPRX, from its leading comment; other bytes as they are. */
function unwrapHtml(bytes: Uint8Array): Uint8Array {
  if (!HTML_OPEN.every((b, i) => bytes[i] === b)) return bytes;
  outer: for (let i = HTML_OPEN.length; i + HTML_CLOSE.length <= bytes.length; i++) {
    for (let j = 0; j < HTML_CLOSE.length; j++) {
      if (bytes[i + j] !== HTML_CLOSE[j]) continue outer;
    }
    return bytes.subarray(HTML_OPEN.length, i);
  }
  throw new Error("The .x.html capture has no end to its data comment");
}

export class LibMPHost {
  private readonly ctx: Record<string, any>;
  private readonly inContext: (bytes: Uint8Array) => Uint8Array;
  private runtime: any = null;
  private viewerLoaded = false;
  private exported: string | null = null;

  private constructor() {
    const host = this;
    this.ctx = vm.createContext({
      console: { log() {}, info() {}, debug() {}, warn: console.warn, error: console.error },
      // LibMP's tools take their Node paths when process.versions.node is set.
      process: { versions: process.versions, argv: [], env: {} },
      require: createRequire(import.meta.url),
      // tools.js runs its own CLI when require.main === module.
      module: {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      TextEncoder,
      TextDecoder,
      URL,
      WebAssembly,
      performance,
      atob,
      btoa,
      g_cliMode: true,
      g_cliSkipInitLevel: 0,
      // The viewer hands every export's result to cpp.ExportResult in CLI mode.
      cpp: {
        ExportResult(result: string) {
          host.exported = result;
        },
      },
    });
    this.ctx.globalThis = this.ctx;
    vm.runInContext(libmpJs, this.ctx, { filename: "libmp.js" });
    vm.runInContext(toolsJs, this.ctx, { filename: "tools.js" });
    // LibMP checks `instanceof Uint8Array` against its own context's class.
    this.inContext = vm.runInContext("(b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)", this.ctx);
  }

  static async create(): Promise<LibMPHost> {
    const host = new LibMPHost();
    host.runtime = await host.ctx.LibMP.create();
    return host;
  }

  /**
   * How many dumps a capture holds: one per segment of its first track, or
   * one for a capture without tracks (what Studio writes).
   */
  segmentCount(bytes: Uint8Array, name: string): number {
    const session = this.runtime.Session.OpenFromBuffer(this.inContext(unwrapHtml(bytes)));
    if (!session?.IsValid()) throw new Error(`LibMP can't open ${name}`);
    try {
      return session.GetTrackCount() ? session.GetSegmentCount(0) : 1;
    } finally {
      session.Dispose();
    }
  }

  /** One dump's flame graph containers: CPU time, allocation count and allocation size. */
  async containers(bytes: Uint8Array, fileName: string, segmentIndex?: number): Promise<Container[]> {
    const html: string = await this.ctx.LibMPTools.ExportFramegraph(COMBO_EXPORT, [
      { captureBytes: this.inContext(unwrapHtml(bytes)), fileName, localGroupId: 0, segmentIndex },
    ]);
    return containersFromPage(html);
  }

  /** LibMP's flame graph page around these containers. */
  renderPage(containers: Container[]): string {
    return this.ctx.LibMPTools.RenderFramegraphHtml(containers);
  }

  /** Load a dump into the viewer; returns the viewer's globals. */
  async loadViewer(bytes: Uint8Array, segmentIndex?: number): Promise<Record<string, any>> {
    this.ctx.LibMPTools.Configure({ captureBytes: this.inContext(unwrapHtml(bytes)), segmentIndex });
    if (this.viewerLoaded) {
      await this.ctx.CliInitMinimal();
    } else {
      // Loading the viewer initializes it from the configured capture.
      vm.runInContext(viewerJs, this.ctx, { filename: "viewer.js" });
      this.viewerLoaded = true;
      await this.ctx.LibMPViewerReady;
    }
    return this.ctx;
  }

  /** Run one of the viewer's exports (ExportSummaryJSON, ...) on the loaded dump. */
  export(fnName: string): string | null {
    this.exported = null;
    this.ctx[fnName]();
    const result = this.exported;
    this.exported = null;
    return result;
  }

  /**
   * The capture in another LibMP container format. A `.x.html` loads its
   * viewer from Roblox's asset host, as the ones Studio writes do.
   */
  convert(bytes: Uint8Array, name: string, format: ConvertFormat): Uint8Array {
    const session = this.runtime.Session.OpenFromBuffer(this.inContext(unwrapHtml(bytes)));
    if (!session?.IsValid()) throw new Error(`LibMP can't open ${name}`);
    try {
      if (!this.runtime.Tools.SetHtmlAssetsBaseUrl(VIEWER_ASSETS)) {
        throw new Error("LibMP rejected the viewer assets URL");
      }
      const result = this.runtime.Tools.ConvertToBuffer(session, CONTAINER_FORMATS[format]);
      if (!result) throw new Error(`LibMP couldn't convert ${name}`);
      return new Uint8Array(result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength));
    } finally {
      session.Dispose();
    }
  }
}

let host: Promise<LibMPHost> | null = null;

/** The process's LibMP host, created on first use. */
export function getLibMP(): Promise<LibMPHost> {
  host ||= LibMPHost.create();
  return host;
}
