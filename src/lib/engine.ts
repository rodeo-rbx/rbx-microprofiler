/**
 * Low-level WASM loader — sets up DOM stubs, evals the Emscripten tools JS
 * and viewer JS, and provides init/reload/parse primitives.
 *
 * This module is internal. Use MicroProfiler from lib/index.ts instead.
 */

import { createRequire } from "node:module";
import { getToolsJs, getViewerJs } from "../template.js";
import { patchToolsJs, patchViewerJs, type WasmMemoryConfig } from "./patch.js";

declare const globalThis: Record<string, any>;

const _require = createRequire(import.meta.url);

let _initialized = false;

// ── Console suppression ──

export function silent<T>(fn: () => T): T {
  const origLog = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
  }
}

export async function silentAsync<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
  }
}

// ── DOM stubs ──

const domStub = () => ({ style: {}, getContext: () => ({}), width: 0, height: 0, innerHTML: "" });

function setupDomStubs(): void {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = {
    childNodes: [],
    getElementById: domStub,
    createElement: domStub,
    title: "",
  };
  globalThis.navigator = { platform: "" };
  if (!globalThis.location) {
    globalThis.location = { hash: "", pathname: "" };
  }
  globalThis.Node = { COMMENT_NODE: 8 };
  globalThis.cpp = null;

  if (typeof globalThis.FileReader === "undefined") {
    globalThis.FileReader = class FileReader {
      result: ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: ((e: Error) => void) | null = null;
      readAsArrayBuffer(blob: Blob) {
        blob.arrayBuffer().then((buf) => {
          this.result = buf;
          this.onload?.();
        }).catch((e: Error) => {
          this.onerror?.(e);
        });
      }
    };
  }
}

// ── Payload preparation ──

function preparePayload(rawData: Uint8Array): Uint8Array {
  const payload = new Uint8Array(rawData.length);
  payload.set(rawData);
  // Replace 4 zero bytes with spaces to match "    R0FL" format
  payload[0] = 0x20; payload[1] = 0x20; payload[2] = 0x20; payload[3] = 0x20;
  return payload;
}

async function parseWithWasm(payload: Uint8Array): Promise<void> {
  const Module: any = await silentAsync(() => globalThis.ToolsModule());
  globalThis.Tools = Module;

  silent(() => Module.ccall("Init", "number", []));
  globalThis.g_Loader.toolsData.exportOptions = JSON.parse(
    globalThis.g_Loader.toolsData.exportResult
  );
  globalThis.g_Loader.toolsData.exportResult = null;

  const meta = JSON.stringify({ fileName: "dump.raw", localId: 0, localGroupId: 0 });
  const parseRaw = Module.cwrap("ParseRaw", "number", ["string", "number", "number"]);
  const dataPtr = Module._malloc(payload.length) >>> 0;
  Module.HEAPU8.set(payload, dataPtr);
  silent(() => parseRaw(meta, dataPtr, payload.length));
  Module._free(dataPtr);

  globalThis.g_Loader.isDataInitialized = true;
  globalThis.g_Loader.rawDataArr = payload;
  globalThis.Tools = null;
}

function runViewerInit(): void {
  globalThis.InitViewerVars();
  globalThis.InitPluginVars();
  globalThis.InitGroups();
  globalThis.InitFrameInfo();
  globalThis.PreprocessMinimal();
}

/**
 * Roblox's WASM profiler exporter writes profiler labels into JS array literals
 * (e.g. `S.tl0 = ["label","label",...]`) and calls back into JS to `eval` them —
 * but it does NOT escape double-quotes inside the labels. A label can legitimately
 * contain quotes: most notably an inlined-source run, where the script's
 * ModuleScript name is its own source, e.g.
 *   local x = game:GetService("HttpService")
 * The unescaped inner `"` terminates the JS string early, so `eval` throws a
 * SyntaxError and the whole dump fails to load.
 *
 * Re-escape: walk the statement and treat a `"` as a string *terminator* only
 * when the next non-space char is structural (`,` `]` `}` `;` newline / EOF);
 * otherwise it is label content and gets escaped to `\"`. Backslashes are doubled
 * so the labels survive intact. Run only as a fallback on a failed eval, so
 * well-formed statements are untouched.
 */
function escapeUnescapedLabelQuotes(js: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < js.length; i++) {
    const c = js[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
    } else if (c === "\\") {
      out += "\\\\";
    } else if (c === '"') {
      let j = i + 1;
      while (j < js.length && (js[j] === " " || js[j] === "\t")) j++;
      const next = j < js.length ? js[j] : "";
      const terminator =
        next === "" || next === "," || next === "]" || next === "}" || next === ";" || next === "\n" || next === "\r";
      if (terminator) {
        out += '"';
        inStr = false;
      } else {
        out += '\\"';
      }
    } else {
      out += c;
    }
  }
  return out;
}

// ── Public API ──

const DEFAULT_MEMORY_CONFIG: WasmMemoryConfig = {
  maxMemoryBytes: 4 * 1024 * 1024 * 1024, // 4GB
};

let _loaded = false;

/** Evaluate the tools and viewer JS onto the process globals, once. */
function loadEngine(memoryConfig: WasmMemoryConfig): void {
  if (_loaded) return;

  globalThis.g_cliMode = true;
  globalThis.g_cliSkipInitLevel = 999;
  globalThis.__require = _require;
  setupDomStubs();

  let toolsJs = getToolsJs();
  toolsJs = patchToolsJs(toolsJs, memoryConfig);
  const wrappedTools = `
    var module = { exports: {} };
    var exports = module.exports;
    var define = undefined;
    var require = globalThis.__require;
    var __filename = globalThis.__filename || "/engine.js";
    var __dirname = globalThis.__dirname || "/";
    ${toolsJs}
    globalThis.ToolsModule = module.exports.default || module.exports;
  `;
  (0, eval)(wrappedTools);

  if (typeof globalThis.ToolsModule !== "function") {
    throw new Error("ToolsModule not defined after loading tools JS");
  }

  // Eval viewer JS (with auto-init removed)
  let viewerJs = getViewerJs();
  const marker = "if (globalThis.g_cliMode) {\n    CliInitMinimal();";
  const lastIdx = viewerJs.lastIndexOf(marker);
  if (lastIdx !== -1) {
    viewerJs = viewerJs.slice(0, lastIdx) + "// auto-init removed";
  }

  globalThis.S = {};
  globalThis.g_Loader = {};
  globalThis.g_Loader.urlAnchor = "";
  viewerJs = viewerJs.replace(/^var S = \{\};$/m, "S = {};");
  viewerJs = viewerJs.replace(/^var g_Loader = \{\};$/m, "g_Loader = {};");
  viewerJs = patchViewerJs(viewerJs, memoryConfig);

  globalThis.eval(viewerJs);

  // The WASM exporter eval's JS array literals of profiler labels without
  // escaping inner double-quotes (see escapeUnescapedLabelQuotes). Make the
  // eval callback tolerant: retry once with inner quotes escaped on SyntaxError.
  {
    const _origExec = globalThis.ExecStatement;
    if (typeof _origExec === "function") {
      globalThis.ExecStatement = function (js: string) {
        try {
          return _origExec(js);
        } catch (e: any) {
          if (e instanceof SyntaxError || e?.name === "SyntaxError") {
            return _origExec(escapeUnescapedLabelQuotes(js));
          }
          throw e;
        }
      };
    }
  }

  globalThis.document.getElementById = domStub;
  globalThis.document.createElement = domStub;
  globalThis.ExtractRawData = async () => {};
  globalThis.g_Loader.toolsData = {};
  _loaded = true;
}

export async function initWasm(rawData: Uint8Array, memoryConfig: WasmMemoryConfig = DEFAULT_MEMORY_CONFIG): Promise<void> {
  if (_initialized) {
    throw new Error("Engine already initialized.");
  }
  loadEngine(memoryConfig);

  // Parse the initial dump
  globalThis.g_Loader.toolsData = {};
  globalThis.InitDataVars();

  const payload = preparePayload(rawData);
  await parseWithWasm(payload);
  runViewerInit();

  // Set ComboDiffFuncName from exportOptions
  for (const entry of globalThis.g_Loader.toolsData.exportOptions || []) {
    if (entry.comboDiff) {
      globalThis.g_Loader.toolsData.ComboDiffFuncName = entry.funcName;
      break;
    }
  }

  _initialized = true;
}

export async function reloadWasm(rawData: Uint8Array): Promise<void> {
  if (!_initialized) {
    throw new Error("Engine not initialized. Call initWasm first.");
  }

  globalThis.g_Loader.toolsData = {};
  globalThis.InitDataVars();

  const payload = preparePayload(rawData);
  await parseWithWasm(payload);
  runViewerInit();

  // Re-set ComboDiffFuncName (cleared by toolsData reset)
  for (const entry of globalThis.g_Loader.toolsData.exportOptions || []) {
    if (entry.comboDiff) {
      globalThis.g_Loader.toolsData.ComboDiffFuncName = entry.funcName;
      break;
    }
  }

  // Re-override ExtractRawData (may have been reset)
  globalThis.ExtractRawData = async () => {};
}

export function isInitialized(): boolean {
  return _initialized;
}

export interface ComboInput {
  /** Dump bytes, starting with the R0FL header. */
  data: Uint8Array;
  fileName: string;
}

/**
 * Run the engine's combo flame graph export (what the viewer's ExportDiffSides
 * runs) over these dumps and return its page, which holds each dump's
 * containers. Each call gets a fresh WASM instance, so memory is bounded by
 * the dumps passed in, not by earlier calls.
 */
export async function exportComboPage(dumps: ComboInput[]): Promise<string> {
  loadEngine(DEFAULT_MEMORY_CONFIG);
  const Module: any = await silentAsync(() => globalThis.ToolsModule());
  globalThis.Tools = Module;
  try {
    silent(() => Module.ccall("Init", "number", []));
    const options: any[] = JSON.parse(globalThis.g_Loader.toolsData.exportResult);
    globalThis.g_Loader.toolsData.exportResult = null;
    const combo = options.find((entry) => entry.comboDiff);
    if (!combo) throw new Error("The legacy engine has no combo export");

    const exporter = Module.cwrap(combo.funcName, "number", ["string", "number", "number"]);
    const call = (meta: string, data: Uint8Array) => {
      const ptr = Module._malloc(data.length) >>> 0;
      Module.HEAPU8.set(data, ptr);
      silent(() => exporter(meta, ptr, data.length));
      Module._free(ptr);
    };
    dumps.forEach((dump, localId) => {
      call(JSON.stringify({ fileName: dump.fileName, localId, localGroupId: 0 }), dump.data);
    });
    // Multi-dump exporters write their page on a final call without a dump.
    if (combo.multiRaw) call("", new Uint8Array(1));

    const page = globalThis.g_Loader.toolsData.exportResult;
    globalThis.g_Loader.toolsData.exportResult = null;
    if (!page) throw new Error("The legacy engine's combo export returned nothing");
    return page;
  } finally {
    globalThis.Tools = null;
  }
}
