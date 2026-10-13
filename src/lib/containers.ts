/**
 * Flame graph containers — the per-dump data a MicroProfiler flame graph page
 * embeds: one container per metric (CPU time, allocation count, allocation
 * size), each a top-down tree of total values over the dump's frames.
 */

export interface FlameNode {
  name: string;
  displayValue: number;
  displayCount: number;
  value?: number;
  color: string;
  groupName: string;
  timerIndex: number;
  children: FlameNode[];
}

export interface DumpInfo {
  fileName: string;
  localId: number;
  localGroupId: number;
  numberOfFrames: number;
  utcCaptureTime: number;
  placeId: string;
}

export interface Container {
  title: string;
  shortName: string;
  units: string;
  dumpInfo: DumpInfo;
  topDown: FlameNode;
  bottomUp?: FlameNode;
}

const DECLARATION = "const source_containers_json = ";

/**
 * The containers a flame graph page embeds. LibMP's pages hold them as one
 * JSON array on the declaration's line; the legacy engine's pages hold one
 * `JSON.parse('…')` per container on the lines after it.
 */
export function containersFromPage(html: string): Container[] {
  const start = html.indexOf(DECLARATION);
  if (start < 0) throw new Error("The flame graph page has no containers");
  const from = start + DECLARATION.length;
  const lineEnd = html.indexOf("\n", from);
  const line = html.slice(from, lineEnd < 0 ? undefined : lineEnd).trim();
  if (line !== "[") return JSON.parse(line.replace(/;$/, ""));

  const containers: Container[] = [];
  let pos = from;
  for (;;) {
    const call = html.indexOf("JSON.parse('", pos);
    const end = html.indexOf("];", pos);
    if (call < 0 || (end >= 0 && end < call)) break;
    const literal = readSingleQuoted(html, call + "JSON.parse(".length);
    containers.push(JSON.parse(literal.value));
    pos = literal.end;
  }
  return containers;
}

/** Decode the single-quoted JavaScript string literal that starts at `pos`. */
function readSingleQuoted(src: string, pos: number): { value: string; end: number } {
  let out = "";
  let i = pos + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") return { value: out, end: i + 1 };
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const e = src[i + 1];
    i += 2;
    switch (e) {
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0": out += "\0"; break;
      case "x":
        out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16));
        i += 2;
        break;
      case "u":
        out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16));
        i += 4;
        break;
      case "\n": break;
      default: out += e;
    }
  }
  throw new Error("Unterminated string in the flame graph page");
}
