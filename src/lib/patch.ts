/**
 * WASM memory limit patching for Emscripten-compiled MicroProfiler.
 *
 * Roblox ships the WASM module with a 2GB memory cap. These patches raise it
 * to a configurable limit by modifying the JS glue and WASM binary in-place.
 *
 * Three layers:
 *  1. JS-side: getHeapMax() guard — returns the target byte limit
 *  2. WASM binary: memory section maximum pages (LEB128)
 *  3. Unsigned pointer coercion (>>> 0) — only needed when limit > 2GB,
 *     because WASM32 returns signed i32 pointers that wrap negative above 2GB
 */

export interface WasmMemoryConfig {
  /** Target max memory in bytes. Must be a multiple of 64KB (WASM page size). */
  maxMemoryBytes: number;
}

const WASM_PAGE_SIZE = 65536; // 64KB
const TWO_GB = 2 * 1024 * 1024 * 1024;
const DEFAULT_HEAP_MAX = 2147483648; // 2GB — what Roblox ships

// ── LEB128 helpers ──

function decodeLeb128(bytes: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0, shift = 0, length = 0, b: number;
  do {
    b = bytes[offset + length];
    value |= (b & 0x7f) << shift;
    shift += 7;
    length++;
  } while (b & 0x80);
  return { value, length };
}

function encodeLeb128(value: number): number[] {
  const result: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    result.push(byte);
  } while (value !== 0);
  return result;
}

// ── WASM binary patch ──

/** Patch the embedded WASM binary's memory section to set max pages. */
function patchWasmBinary(toolsJs: string, targetPages: number): string {
  const marker = 'base64Decode("';
  const start = toolsJs.indexOf(marker);
  if (start === -1) return toolsJs;
  const b64Start = start + marker.length;
  const b64End = toolsJs.indexOf('")', b64Start);
  if (b64End === -1) return toolsJs;

  const bytes = Buffer.from(toolsJs.slice(b64Start, b64End), "base64");

  // Find memory section (id=5) and patch maximum pages LEB128
  let offset = 8; // skip magic + version
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    let size = 0, shift = 0, b: number;
    do { b = bytes[offset++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);

    if (sectionId === 5) {
      let pos = offset;
      pos++; // skip count (1)
      const flags = bytes[pos++];
      // skip initial pages LEB128
      do { b = bytes[pos++]; } while (b & 0x80);
      if (flags & 1) {
        // Read existing max pages
        const existing = decodeLeb128(bytes, pos);
        const newEncoded = encodeLeb128(targetPages);
        // Pad to same length so base64 stays aligned
        while (newEncoded.length < existing.length) newEncoded.push(0);
        if (newEncoded.length === existing.length) {
          for (let i = 0; i < newEncoded.length; i++) {
            bytes[pos + i] = newEncoded[i];
          }
          const patched = bytes.toString("base64");
          return toolsJs.slice(0, b64Start) + patched + toolsJs.slice(b64End);
        }
      }
      break;
    }
    offset += size;
  }
  return toolsJs;
}

// ── Unsigned pointer coercions ──

/**
 * Patch Emscripten JS glue to treat WASM pointers as unsigned uint32.
 *
 * WASM32 functions return i32 — JS engines represent these as signed Int32.
 * Addresses above 2GB (0x80000000+) appear negative. Emscripten normally adds
 * `>>> 0` coercions when compiled with MAXIMUM_MEMORY > 2GB. Since we're
 * patching a pre-compiled module, we apply the same coercions via string replacement.
 */
function patchUnsignedPointers(js: string): string {
  // createExportWrapper: coerce return values from all WASM exports.
  // `>>> 0` on non-pointer returns (booleans, error codes) is harmless.
  js = js.replace(
    "return f(...args)}",
    "return f(...args)>>>0}",
  );

  // writeArrayToMemory: HEAP8.set(array, buffer) — buffer is a pointer
  js = js.replace(
    "HEAP8.set(array,buffer)",
    "HEAP8.set(array,buffer>>>0)",
  );

  // stackAlloc: returns a pointer
  js = js.replace(
    "var stackAlloc=sz=>__emscripten_stack_alloc(sz)",
    "var stackAlloc=sz=>__emscripten_stack_alloc(sz)>>>0",
  );

  // stringToUTF8Array: outIdx is a pointer used as heap index.
  // Coerce at entry so all subsequent heap[outIdx++] work correctly.
  js = js.replace(
    "stringToUTF8Array=(str,heap,outIdx,maxBytesToWrite)=>{",
    "stringToUTF8Array=(str,heap,outIdx,maxBytesToWrite)=>{outIdx>>>=0;",
  );

  // UTF8ArrayToString: idx is a pointer used as heap index.
  js = js.replace(
    "UTF8ArrayToString=(heapOrArray,idx=0,maxBytesToRead=NaN)=>{",
    "UTF8ArrayToString=(heapOrArray,idx=0,maxBytesToRead=NaN)=>{idx>>>=0;",
  );

  return js;
}

// ── Public API ──

/** Patch tools JS (Emscripten glue + embedded WASM binary) for a given memory limit. */
export function patchToolsJs(toolsJs: string, config: WasmMemoryConfig): string {
  const targetPages = config.maxMemoryBytes / WASM_PAGE_SIZE;

  // 1. JS-side heap guard
  toolsJs = toolsJs.replace(
    `var getHeapMax=()=>${DEFAULT_HEAP_MAX}`,
    `var getHeapMax=()=>${config.maxMemoryBytes}`,
  );

  // 2. WASM binary memory section
  toolsJs = patchWasmBinary(toolsJs, targetPages);

  // 3. Unsigned pointer coercions (only needed above 2GB)
  if (config.maxMemoryBytes > TWO_GB) {
    toolsJs = patchUnsignedPointers(toolsJs);
  }

  return toolsJs;
}

/** Patch viewer JS for >2GB memory (unsigned pointer coercions in CallFunc). */
export function patchViewerJs(viewerJs: string, config: WasmMemoryConfig): string {
  if (config.maxMemoryBytes <= TWO_GB) return viewerJs;

  viewerJs = viewerJs.replace(
    "Tools.HEAPU8.set(localRawDataArr, dataPtr)",
    "Tools.HEAPU8.set(localRawDataArr, dataPtr>>>0)",
  );
  viewerJs = viewerJs.replace(
    "var dataPtr = Tools._malloc(localRawDataArr.length)",
    "var dataPtr = Tools._malloc(localRawDataArr.length)>>>0",
  );

  return viewerJs;
}
