/**
 * Flame graph page — LibMP's flame graph template around merged containers.
 *
 * The page reads its header (dump count, collection time range, place IDs,
 * the dump table) and its view mode (single dump, combo, diff) from the dump
 * info of each container it holds. Merged containers stand for many dumps, so
 * the page also gets the dumps' own info, and its IterateSourceContainers —
 * the only reader of per-dump info — walks that list instead.
 */

import type { DumpInfo } from "./containers.js";
import type { ContainerMerge } from "./merge.js";
import { getLibMP } from "./libmp.js";

const DATA_DECLARATION = "const source_containers_json = ";
const ITERATE_HEAD = "function IterateSourceContainers(func) {\n";
const ITERATE_DUMPS = `    if (typeof source_dumps_json !== "undefined") {
        source_dumps_json.forEach(dumpInfo => func({ dumpInfo: dumpInfo }));
        return;
    }
`;

/** JSON for a <script> block, escaped as LibMP's tools escape it. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function withDumpList(html: string, dumps: DumpInfo[]): string {
  const data = html.indexOf(DATA_DECLARATION);
  const iterate = html.indexOf(ITERATE_HEAD);
  if (data < 0 || iterate < 0) {
    throw new Error("LibMP's flame graph template changed: no container data or IterateSourceContainers");
  }
  const dataEnd = html.indexOf("\n", data);
  const iterateBody = iterate + ITERATE_HEAD.length;
  return (
    html.slice(0, dataEnd) +
    `\nconst source_dumps_json = ${jsonForScript(dumps)};` +
    html.slice(dataEnd, iterateBody) +
    ITERATE_DUMPS +
    html.slice(iterateBody)
  );
}

/** The flame graph page for a merge: a single dump's page, or a combo or diff page. */
export async function renderFlamegraphPage(merge: ContainerMerge): Promise<string> {
  const libmp = await getLibMP();
  const html = libmp.renderPage(merge.pageContainers());
  return merge.dumps.length > 1 ? withDumpList(html, merge.dumps) : html;
}
