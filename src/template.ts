/**
 * Template extraction — splits template.html into its 3 parts:
 *   Line 1: R0FL dump data (base64+zlib comment)
 *   Line 2: Emscripten Tools JS glue (base64+zlib comment)
 *   Lines 3+: Viewer JS (HTML wrapper)
 */

import { inflate } from "./zlib.js";

// Embedded at compile time by Bun's bundler
import templateHtml from "../template.html" with { type: "text" };

let _cachedToolsJs: string | null = null;
let _cachedViewerJs: string | null = null;

function getLines(): [string, string, string] {
  const firstNewline = templateHtml.indexOf("\n");
  const secondNewline = templateHtml.indexOf("\n", firstNewline + 1);

  const line1 = templateHtml.slice(0, firstNewline);
  const line2 = templateHtml.slice(firstNewline + 1, secondNewline);
  const rest = templateHtml.slice(secondNewline + 1);

  return [line1, line2, rest];
}

/** Decode a base64+zlib HTML comment (with 8-byte size header). */
function decodeComment(comment: string, magic: string): Uint8Array {
  // Strip <!-- and -->
  let data = comment.trim();
  if (data.startsWith("<!--")) data = data.slice(4);
  if (data.endsWith("-->")) data = data.slice(0, -3);

  // Strip magic prefix (e.g. "R0FL")
  if (magic && data.startsWith(magic)) {
    data = data.slice(magic.length);
  }

  // Base64 decode
  const compressed = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

  // First 8 bytes: u32le uncompressed size, u32le compressed size
  const view = new DataView(compressed.buffer);
  const uncompressedSize = view.getUint32(0, true);

  // Decompress (skip 8-byte header)
  const payload = compressed.slice(8);
  return inflate(payload, uncompressedSize);
}

/** Get the raw R0FL dump data from line 1 of a template HTML file. */
export function extractRawFromHtml(html: string): Uint8Array {
  const firstNewline = html.indexOf("\n");
  const line1 = html.slice(0, firstNewline);
  return decodeComment(line1, "R0FL");
}

/** Get the decoded Emscripten Tools JS (defines ToolsModule factory). */
export function getToolsJs(): string {
  if (_cachedToolsJs) return _cachedToolsJs;
  const [, line2] = getLines();
  const decoded = decodeComment(line2, "");
  _cachedToolsJs = new TextDecoder().decode(decoded);
  return _cachedToolsJs;
}

/** Get the viewer JS (lines 3+ with HTML wrappers stripped). */
export function getViewerJs(): string {
  if (_cachedViewerJs) return _cachedViewerJs;
  const [, , rest] = getLines();

  // Strip HTML wrappers: <!DOCTYPE html>\n<html><script>\n ... \n</script></html>
  let js = rest;
  // Remove leading HTML
  const scriptStart = js.indexOf("<script>");
  if (scriptStart !== -1) {
    js = js.slice(scriptStart + "<script>".length);
  }
  // Remove trailing HTML
  const scriptEnd = js.lastIndexOf("</script>");
  if (scriptEnd !== -1) {
    js = js.slice(0, scriptEnd);
  }

  // Normalize line endings to LF. On Windows, git's autocrlf checks
  // template.html out with CRLF, and the engine's LF-based string surgery on
  // the viewer JS (the auto-init `CliInitMinimal()` strip and the `^var S =
  // {};$` regex patches) then silently no-ops — so CliInitMinimal() runs at
  // eval time and throws "InitDataImpl is not defined". JS evals identically
  // with either line ending, so normalizing here is safe.
  js = js.replace(/\r\n/g, "\n");

  _cachedViewerJs = js;
  return _cachedViewerJs;
}

/** Get the full template HTML (for reconstructing output files). */
export function getTemplateHtml(): string {
  return templateHtml;
}

/**
 * Get just the line 2 comment (Tools JS, still encoded) for HTML reconstruction.
 */
export function getToolsLine(): string {
  const [, line2] = getLines();
  return line2;
}
