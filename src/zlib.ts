/**
 * Zlib inflate/deflate wrappers using Bun's native zlib.
 */

import { inflateSync, deflateSync } from "node:zlib";

/** Decompress raw deflate data. */
export function inflate(data: Uint8Array, expectedSize?: number): Uint8Array {
  // Use raw inflate (no zlib header) — the template uses "deflate" method
  const result = inflateSync(Buffer.from(data));
  return new Uint8Array(result);
}

/** Compress data with raw deflate. */
export function deflate(data: Uint8Array): Uint8Array {
  const result = deflateSync(Buffer.from(data));
  return new Uint8Array(result);
}
