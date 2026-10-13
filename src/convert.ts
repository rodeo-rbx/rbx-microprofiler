/**
 * Format conversion — extract events from parsed microprofiler dumps
 * and write as Chrome Trace JSON or Perfetto protobuf trace.
 */

import { writeFileSync } from "node:fs";
import protobuf from "protobufjs";
import perfettoJson from "./perfetto.json";
import { MicroProfiler, type RawEvent } from "./lib/index.js";
import type { DumpRef } from "./lib/dumps.js";

// ── Chrome Trace JSON export ──

export async function extractTraceJson(files: DumpRef[], outputPath: string): Promise<void> {
  const mp = await MicroProfiler.load(files[0].path, undefined, files[0].segment);
  const parts: string[] = [];

  // Thread metadata
  for (const t of mp.threads) {
    parts.push(
      `{"ph":"M","pid":0,"tid":${t.tid},"name":"thread_name","args":{"name":${JSON.stringify(t.name)}}}`
    );
  }

  console.error(`Extracting ${files.length} dump(s) to Chrome Trace JSON...`);
  let totalFrames = 0;

  for (let fi = 0; fi < files.length; fi++) {
    if (fi > 0) await mp.reload(files[fi].path, files[fi].segment);

    const offsetMs = mp.absoluteOffsetMs();
    const frameCount = mp.frameCount;
    console.error(`  [${fi + 1}/${files.length}] ${frameCount} frames, offset ${offsetMs.toFixed(0)} ms`);

    // Register any new threads
    if (fi > 0) {
      for (const t of mp.threads) {
        parts.push(
          `{"ph":"M","pid":0,"tid":${t.tid},"name":"thread_name","args":{"name":${JSON.stringify(t.name)}}}`
        );
      }
    }

    for (const evt of mp.extractEvents()) {
      const absTs = (evt.ts + offsetMs) * 1000; // ms → µs for Chrome Trace
      let line = `{"ph":"${evt.ph}","ts":${absTs},"pid":0,"tid":${evt.tid},"name":${JSON.stringify(evt.name)},"cat":${JSON.stringify(evt.cat)}`;
      if (evt.ph === "i") line += ',"s":"t"';
      if (evt.label) line += `,"args":{"label":${JSON.stringify(evt.label)}}`;
      line += "}";
      parts.push(line);
    }

    totalFrames += frameCount;
  }

  const json = `{"traceEvents":[\n${parts.join(",\n")}\n],"displayTimeUnit":"ms"}\n`;
  writeFileSync(outputPath, json);

  const sizeMb = json.length / (1024 * 1024);
  console.error(`Total: ${totalFrames} frames → ${outputPath} (${sizeMb.toFixed(1)} MB)`);
}

// ── Perfetto protobuf trace export ──

const _protoRoot = protobuf.Root.fromJSON(perfettoJson as protobuf.INamespace);

export async function extractPerfetto(files: DumpRef[], outputPath: string): Promise<void> {
  const TracePacket = _protoRoot.lookupType("perfetto.protos.TracePacket");

  const PROCESS_UUID = 1;
  const SEQUENCE_ID = 1;
  const STATE_CLEAR_INTERVAL = 5000;

  const packets: Uint8Array[] = [];

  function writePacket(obj: Record<string, any>): void {
    const msg = TracePacket.create(obj);
    const buf = TracePacket.encodeDelimited(msg).finish();
    packets.push(buf);
  }

  writePacket({
    trustedPacketSequenceId: SEQUENCE_ID,
    trackDescriptor: {
      uuid: PROCESS_UUID,
      process: { pid: 1, processName: "Roblox" },
    },
  });

  const threadUuids = new Map<number, number>();
  const nameToIid = new Map<string, number>();
  const catToIid = new Map<string, number>();
  let nextNameIid = 1;
  let nextCatIid = 1;
  let totalEvents = 0;
  let totalFrames = 0;
  let eventsSinceClear = STATE_CLEAR_INTERVAL;

  function registerThread(tid: number, name: string): number {
    if (threadUuids.has(tid)) return threadUuids.get(tid)!;
    const uuid = tid + 100;
    threadUuids.set(tid, uuid);
    writePacket({
      trustedPacketSequenceId: SEQUENCE_ID,
      trackDescriptor: {
        uuid,
        parentUuid: PROCESS_UUID,
        thread: { pid: 1, tid, threadName: name },
      },
    });
    return uuid;
  }

  const mp = await MicroProfiler.load(files[0].path, undefined, files[0].segment);

  for (let fi = 0; fi < files.length; fi++) {
    if (fi > 0) await mp.reload(files[fi].path, files[fi].segment);

    const offsetMs = mp.absoluteOffsetMs();
    const frameCount = mp.frameCount;
    console.error(`  [${fi + 1}/${files.length}] ${frameCount} frames, offset ${offsetMs.toFixed(0)} ms`);

    for (const t of mp.threads) {
      registerThread(t.tid, t.name);
    }

    for (const evt of mp.extractEvents()) {
      const uuid = registerThread(evt.tid, `Thread ${evt.tid}`);
      const tsNs = Math.round((evt.ts + offsetMs) * 1_000_000);

      let eventType: number;
      if (evt.ph === "B") eventType = 1;
      else if (evt.ph === "E") eventType = 2;
      else eventType = 3;

      const needsClear = eventsSinceClear >= STATE_CLEAR_INTERVAL;

      const pkt: Record<string, any> = {
        trustedPacketSequenceId: SEQUENCE_ID,
        timestamp: tsNs,
        sequenceFlags: needsClear ? 1 : 2,
        trackEvent: {
          trackUuid: uuid,
          type: eventType,
        },
      };

      const internedData: Record<string, any> = {};

      if (needsClear) {
        internedData.eventNames = Array.from(nameToIid.entries()).map(([name, iid]) => ({ iid, name }));
        internedData.eventCategories = Array.from(catToIid.entries()).map(([name, iid]) => ({ iid, name }));
        eventsSinceClear = 0;
      }

      if (evt.ph !== "E") {
        const newName = !nameToIid.has(evt.name);
        if (newName) nameToIid.set(evt.name, nextNameIid++);
        const nameIid = nameToIid.get(evt.name)!;
        pkt.trackEvent.nameIid = nameIid;
        if (newName && !needsClear) {
          if (!internedData.eventNames) internedData.eventNames = [];
          internedData.eventNames.push({ iid: nameIid, name: evt.name });
        }

        if (evt.cat) {
          const newCat = !catToIid.has(evt.cat);
          if (newCat) catToIid.set(evt.cat, nextCatIid++);
          const catIid = catToIid.get(evt.cat)!;
          pkt.trackEvent.categoryIids = [catIid];
          if (newCat && !needsClear) {
            if (!internedData.eventCategories) internedData.eventCategories = [];
            internedData.eventCategories.push({ iid: catIid, name: evt.cat });
          }
        }

        pkt.trackEvent.debugAnnotations = [{ name: "timer_id", intValue: evt.timer_id }];
      }

      if (Object.keys(internedData).length > 0) {
        pkt.internedData = internedData;
      }

      writePacket(pkt);
      totalEvents++;
      eventsSinceClear++;
    }

    totalFrames += frameCount;
  }

  const totalSize = packets.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const p of packets) {
    result.set(p, offset);
    offset += p.length;
  }

  writeFileSync(outputPath, result);
  const sizeMb = totalSize / (1024 * 1024);
  console.error(`Total: ${totalFrames} frames, ${totalEvents} events → ${outputPath} (${sizeMb.toFixed(1)} MB)`);
}
