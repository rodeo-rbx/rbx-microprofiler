/**
 * R0FL binary format handling.
 *
 * Raw format: 4 zero bytes + "R0FL" magic + payload
 * HTML format: 3-line file:
 *   Line 1: <!--R0FL{base64(GAK_header + zlib_compressed_payload)}-->
 *   Line 2: <!--{base64(GAK_header + zlib_compressed_tools_js)}-->
 *   Lines 3+: HTML viewer
 *
 * GAK header: "GAK" prefix is NOT used in the comment encoding.
 * The comment has: {u32le_uncompressed_size}{u32le_compressed_size}{zlib_data}
 */

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { extractRawFromHtml, getToolsLine, getViewerJs } from "./template.js";

const R0FL_MAGIC = new Uint8Array([0, 0, 0, 0, 0x52, 0x30, 0x46, 0x4c]); // \0\0\0\0R0FL

/** Read a .raw dump file and return the full bytes (including R0FL header). */
export function readRaw(path: string): Uint8Array {
  const data = new Uint8Array(readFileSync(path));
  // Validate R0FL magic
  if (data.length < 8) throw new Error(`File too small: ${path}`);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== R0FL_MAGIC[i]) {
      throw new Error(`Invalid R0FL magic in ${path}`);
    }
  }
  return data;
}

/** Read a .html dump and extract the raw R0FL data (with header). */
export function readHtml(path: string): Uint8Array {
  const html = readFileSync(path, "utf-8");
  const payload = extractRawFromHtml(html);

  // Check if the decompressed data already contains R0FL marker
  const r0flIdx = findR0FL(payload);
  if (r0flIdx !== -1) {
    // Return from the 4 bytes before R0FL (the zero bytes)
    const start = Math.max(0, r0flIdx - 4);
    return payload.slice(start);
  }

  // Roblox HTML format: the decompressed payload is raw dump data without
  // an R0FL header — the "R0FL" was only the HTML comment prefix. Prepend
  // the standard 8-byte header (\0\0\0\0R0FL).
  const result = new Uint8Array(R0FL_MAGIC.length + payload.length);
  result.set(R0FL_MAGIC, 0);
  result.set(payload, R0FL_MAGIC.length);
  return result;
}

function findR0FL(data: Uint8Array): number {
  const magic = [0x52, 0x30, 0x46, 0x4c]; // R0FL
  for (let i = 0; i < data.length - 4; i++) {
    if (
      data[i] === magic[0] &&
      data[i + 1] === magic[1] &&
      data[i + 2] === magic[2] &&
      data[i + 3] === magic[3]
    ) {
      return i;
    }
  }
  return -1;
}

/** Read a dump file (.raw or .html) and return full R0FL bytes. */
export function readDump(path: string): Uint8Array {
  if (path.endsWith(".html")) {
    return readHtml(path);
  }
  return readRaw(path);
}

/** Encode raw dump payload for embedding in HTML line 1.
 *  Input: raw bytes WITHOUT the R0FL header (just the payload after 8 bytes).
 *  Output: base64 string for the <!--R0FL...--> comment.
 */
export function encodePayloadForHtml(payload: Uint8Array): string {
  const compressed = new Uint8Array(deflateSync(Buffer.from(payload)));

  // Build header: u32le uncompressed size + u32le compressed size
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, compressed.length, true);

  // Concat header + compressed
  const full = new Uint8Array(header.length + compressed.length);
  full.set(header, 0);
  full.set(compressed, header.length);

  return btoa(String.fromCharCode(...full));
}

/** Write a .raw dump as a standalone .html file. */
export function writeHtml(rawData: Uint8Array, outputPath: string): void {
  // Payload = everything after the 8-byte R0FL header
  const payload = rawData.slice(8);
  const dataComment = `<!--R0FL${encodePayloadForHtml(payload)}-->`;
  const toolsLine = getToolsLine();

  // Reconstruct: line1 (data) + line2 (tools) + viewer HTML
  const viewerJs = getViewerJs();
  const viewerHtml = `<!DOCTYPE html>\n<html><script>\n${viewerJs}\n</script></html>`;

  const output = `${dataComment}\n${toolsLine}\n${viewerHtml}`;
  writeFileSync(outputPath, output);
}

/** Extract raw bytes from .html and write as .raw file. */
export function writeRaw(htmlPath: string, outputPath: string): void {
  const rawData = readHtml(htmlPath);
  writeFileSync(outputPath, rawData);
}
