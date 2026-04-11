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

// ── Public API ──

const DEFAULT_MEMORY_CONFIG: WasmMemoryConfig = {
  maxMemoryBytes: 4 * 1024 * 1024 * 1024, // 4GB
};

export async function initWasm(rawData: Uint8Array, memoryConfig: WasmMemoryConfig = DEFAULT_MEMORY_CONFIG): Promise<void> {
  if (_initialized) {
    throw new Error("Engine already initialized.");
  }

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

  globalThis.document.getElementById = domStub;
  globalThis.document.createElement = domStub;
  globalThis.ExtractRawData = async () => {};

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
