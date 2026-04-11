#!/usr/bin/env bun
/**
 * rbx-microprofiler CLI — Roblox MicroProfiler dump analysis.
 */

import { Command } from "commander";
import { readDump } from "./format.js";
import { MicroProfiler } from "./lib/index.js";
import { writeFileSync, statSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";

function openFile(path: string): void {
  if (process.platform === "darwin") execSync(`open "${path}"`);
  else if (process.platform === "linux") execSync(`xdg-open "${path}"`);
  else execSync(`start "${path}"`, { shell: "cmd.exe" });
}

function collectFiles(paths: string[]): string[] {
  const files: string[] = [];
  const supported = new Set([".raw", ".html"]);
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        const ext = f.slice(f.lastIndexOf("."));
        if (supported.has(ext)) files.push(join(p, f));
      }
    } else {
      files.push(p);
    }
  }
  return files;
}

/** Aggregate multiple ExportSummaryJSON results into one. */
function aggregateSummaries(summaries: any[]): any {
  const totalFrames = summaries.reduce((s: number, d: any) => s + d.num_frames, 0);
  const wavg = (key: string) =>
    summaries.reduce((s: number, d: any) => s + d[key] * d.num_frames, 0) / totalFrames;
  const maxOf = (key: string) => Math.max(...summaries.map((d: any) => d[key]));
  const pooledStddev = (meanKey: string, stddevKey: string) => {
    const pooledMean = wavg(meanKey);
    const variance = summaries.reduce((s: number, d: any) => {
      return s + d.num_frames * (d[stddevKey] ** 2 + (d[meanKey] - pooledMean) ** 2);
    }, 0) / totalFrames;
    return Math.sqrt(variance);
  };
  const mergeTopList = (key: string) => {
    const byName = new Map<string, number>();
    for (const d of summaries) {
      for (const entry of d[key] || []) {
        byName.set(entry.name, (byName.get(entry.name) || 0) + entry.total);
      }
    }
    return [...byName.entries()].sort((a, b) => b[1] - a[1]).map(([name, total]) => ({ name, total }));
  };
  const mergeMaxList = (key: string) => {
    const byName = new Map<string, number>();
    for (const d of summaries) {
      for (const entry of d[key] || []) {
        const cur = byName.get(entry.name) || 0;
        if (entry.max > cur) byName.set(entry.name, entry.max);
      }
    }
    return [...byName.entries()].sort((a, b) => b[1] - a[1]).map(([name, max]) => ({ name, max }));
  };

  return {
    num_frames: totalFrames,
    num_dumps: summaries.length,
    num_frames_jobs_heavy: summaries.reduce((s: number, d: any) => s + d.num_frames_jobs_heavy, 0),
    num_frames_rendering_heavy: summaries.reduce((s: number, d: any) => s + d.num_frames_rendering_heavy, 0),
    num_frames_gpu_heavy: summaries.reduce((s: number, d: any) => s + d.num_frames_gpu_heavy, 0),
    cpu_time_median: wavg("cpu_time_median"),
    gpu_time_median: wavg("gpu_time_median"),
    gpu_time_ext_median: wavg("gpu_time_ext_median"),
    cpu_time_mean: wavg("cpu_time_mean"),
    gpu_time_mean: wavg("gpu_time_mean"),
    gpu_time_ext_mean: wavg("gpu_time_ext_mean"),
    cpu_time_max: maxOf("cpu_time_max"),
    gpu_time_max: maxOf("gpu_time_max"),
    gpu_time_ext_max: maxOf("gpu_time_ext_max"),
    cpu_time_stddev: pooledStddev("cpu_time_mean", "cpu_time_stddev"),
    gpu_time_stddev: pooledStddev("gpu_time_mean", "gpu_time_stddev"),
    gpu_time_ext_stddev: pooledStddev("gpu_time_ext_mean", "gpu_time_ext_stddev"),
    cpu_top_by_total_time: mergeTopList("cpu_top_by_total_time"),
    gpu_top_by_total_time: mergeTopList("gpu_top_by_total_time"),
    cpu_by_max_time: mergeMaxList("cpu_by_max_time"),
    gpu_by_max_time: mergeMaxList("gpu_by_max_time"),
    platform_info: summaries[0].platform_info,
    general_info: summaries[0].general_info,
  };
}

const program = new Command()
  .name("rbx-microprofiler")
  .description("Roblox MicroProfiler CLI — flamegraphs, diffs, summaries, and format conversion")
  .version("0.2.0");

// ── summary ──

program
  .command("summary")
  .description("Print a JSON summary of microprofiler dump(s)")
  .argument("<files...>", "Input .raw or .html files or directories")
  .action(async (files: string[]) => {
    const allFiles = collectFiles(files);
    if (allFiles.length === 0) {
      console.error("No .raw or .html files found");
      process.exit(1);
    }

    const mp = await MicroProfiler.load(allFiles[0]);
    const summaries: any[] = [];

    const json = mp.exportSummaryJSON();
    if (json) summaries.push(JSON.parse(json));

    for (let i = 1; i < allFiles.length; i++) {
      await mp.reload(allFiles[i]);
      const j = mp.exportSummaryJSON();
      if (j) summaries.push(JSON.parse(j));
    }

    if (summaries.length === 0) {
      console.error("No summary data returned");
      process.exit(1);
    }

    const result = summaries.length === 1 ? summaries[0] : aggregateSummaries(summaries);
    process.stdout.write(JSON.stringify(result) + "\n");
  });

// ── csv ──

program
  .command("csv")
  .description("Export frame markers or performance counters as CSV")
  .argument("<files...>", "Input .raw or .html files or directories")
  .requiredOption("-o, --output <path>", "Output CSV file")
  .option("--counters", "Export counters instead of markers")
  .option("--open", "Open output in default app")
  .action(async (files: string[], opts: { output: string; counters?: boolean; open?: boolean }) => {
    const allFiles = collectFiles(files);
    if (allFiles.length === 0) {
      console.error("No .raw or .html files found");
      process.exit(1);
    }

    const mp = await MicroProfiler.load(allFiles[0]);
    const result = opts.counters ? mp.exportCountersCSV() : mp.exportMarkersCSV();

    if (result) {
      writeFileSync(opts.output, result);
      console.error(`CSV → ${opts.output}`);
      if (opts.open) openFile(opts.output);
    } else {
      console.error(`Export returned no data`);
      process.exit(1);
    }
  });

// ── flamegraph ──

program
  .command("flamegraph")
  .description("Generate an interactive flamegraph from one or more dumps")
  .argument("<files...>", "Input .raw or .html files or directories")
  .requiredOption("-o, --output <path>", "Output HTML file")
  .option("--open", "Open output in default app")
  .action(async (files: string[], opts: { output: string; open?: boolean }) => {
    const allFiles = collectFiles(files);
    if (allFiles.length === 0) {
      console.error("No .raw or .html files found");
      process.exit(1);
    }

    console.error(`Loading ${allFiles.length} dump(s)...`);
    const mp = await MicroProfiler.load(allFiles[0]);

    mp.initDiffSides();
    for (const f of allFiles.slice(1)) {
      mp.addToDiffSide(0, f);
      console.error(`  added: ${basename(f)}`);
    }

    console.error("Exporting flamegraph...");
    const result = await mp.exportDiffSides(0);

    writeFileSync(opts.output, result);
    console.error(`Flamegraph → ${opts.output} (${(result.length / 1024).toFixed(0)} KB)`);
    if (opts.open) openFile(opts.output);
  });

// ── diff-flamegraph ──

program
  .command("diff-flamegraph")
  .description("Generate a differential flamegraph HTML comparing baseline vs candidate dumps")
  .option("-b, --baseline <paths...>", "Baseline dump files or directories")
  .option("-c, --candidate <paths...>", "Candidate dump files or directories")
  .requiredOption("-o, --output <path>", "Output HTML file")
  .option("--open", "Open output in default app")
  .action(async (opts: { baseline: string[]; candidate: string[]; output: string; open?: boolean }) => {
    if (!opts.baseline?.length || !opts.candidate?.length) {
      console.error("Both --baseline and --candidate are required");
      process.exit(1);
    }

    const baselineFiles = collectFiles(opts.baseline);
    const candidateFiles = collectFiles(opts.candidate);
    if (baselineFiles.length === 0 || candidateFiles.length === 0) {
      console.error("No files found");
      process.exit(1);
    }

    console.error(`Loading viewer with ${basename(baselineFiles[0])}...`);
    const mp = await MicroProfiler.load(baselineFiles[0]);

    mp.initDiffSides();
    for (const f of baselineFiles.slice(1)) {
      mp.addToDiffSide(0, f);
      console.error(`  baseline: ${basename(f)}`);
    }
    for (const f of candidateFiles) {
      mp.addToDiffSide(1, f);
      console.error(`  candidate: ${basename(f)}`);
    }

    console.error("Exporting diff...");
    const result = await mp.exportDiffSides(-1);

    writeFileSync(opts.output, result);
    console.error(`Diff → ${opts.output} (${(result.length / 1024).toFixed(0)} KB)`);
    if (opts.open) openFile(opts.output);
  });

// ── diff ──

program
  .command("diff")
  .description("Compare baseline vs candidate dumps with Bench-style per-node statistics")
  .option("-b, --baseline <paths...>", "Baseline dump files or directories")
  .option("-c, --candidate <paths...>", "Candidate dump files or directories")
  .option("-o, --output <path>", "Write output to file instead of stderr")
  .option("--min-ms <number>", "Hide entries below this threshold", "0")
  .option("--depth <number>", "Max tree depth", "999")
  .action(async (opts: {
    baseline: string[];
    candidate: string[];
    output?: string;
    minMs: string;
    depth: string;
  }) => {
    if (!opts.baseline?.length || !opts.candidate?.length) {
      console.error("Both --baseline and --candidate are required");
      process.exit(1);
    }

    const baselineFiles = collectFiles(opts.baseline);
    const candidateFiles = collectFiles(opts.candidate);
    if (baselineFiles.length === 0 || candidateFiles.length === 0) {
      console.error("No files found");
      process.exit(1);
    }

    console.error(`Loading viewer with ${basename(baselineFiles[0])}...`);
    const mp = await MicroProfiler.load(baselineFiles[0]);

    mp.initDiffSides();
    for (const f of baselineFiles.slice(1)) {
      mp.addToDiffSide(0, f);
      console.error(`  baseline: ${basename(f)}`);
    }
    for (const f of candidateFiles) {
      mp.addToDiffSide(1, f);
      console.error(`  candidate: ${basename(f)}`);
    }

    console.error("Computing diff...");
    const html = await mp.exportDiffSides(-1);

    const { renderDiff } = await import("./diff.js");
    renderDiff(
      html,
      baselineFiles.length,
      candidateFiles.length,
      parseFloat(opts.minMs),
      parseInt(opts.depth),
      opts.output,
    );
  });

// ── convert ──

program
  .command("convert")
  .description("Convert between MicroProfiler formats")
  .argument("<args...>", "Input file(s) followed by output file")
  .action(async (args: string[]) => {
    if (args.length < 2) {
      console.error("Need at least one input file and one output file");
      process.exit(1);
    }

    const outputFile = args[args.length - 1];
    const inputFiles = args.slice(0, -1);

    const { writeHtml, writeRaw } = await import("./format.js");

    const outExt = outputFile.endsWith(".perfetto-trace")
      ? ".perfetto-trace"
      : outputFile.slice(outputFile.lastIndexOf("."));

    if (outExt === ".html") {
      const rawData = readDump(inputFiles[0]);
      writeHtml(rawData, outputFile);
      console.error(`Converted → ${outputFile}`);
    } else if (outExt === ".raw") {
      writeRaw(inputFiles[0], outputFile);
      console.error(`Converted → ${outputFile}`);
    } else if (outExt === ".json") {
      const { extractTraceJson } = await import("./convert.js");
      const allInputs = collectFiles(inputFiles);
      await extractTraceJson(allInputs, outputFile);
    } else if (outExt === ".perfetto-trace") {
      const { extractPerfetto } = await import("./convert.js");
      const allInputs = collectFiles(inputFiles);
      console.error(`Converting ${allInputs.length} dump(s) to Perfetto trace...`);
      await extractPerfetto(allInputs, outputFile);
    } else {
      console.error(`Unsupported output format: ${outExt}`);
      process.exit(1);
    }
  });

// ── analyze ──

program
  .command("analyze")
  .description("Statistically rigorous comparison of baseline vs candidate dumps")
  .option("-b, --baseline <paths...>", "Baseline dump files or directories")
  .option("-c, --candidate <paths...>", "Candidate dump files or directories (repeatable)")
  .option("--noise <threshold>", "Practical significance threshold", "0.01")
  .option("--depth <n>", "Max tree depth", "999")
  .option("--verbose", "Show all stats (min/max/percentiles/std)")
  .option("--json", "Output as JSON instead of CLI tree")
  .action(async (opts: {
    baseline: string[];
    candidate: string[];
    noise: string;
    depth: string;
    verbose?: boolean;
    json?: boolean;
  }) => {
    if (!opts.baseline?.length) {
      console.error("--baseline is required");
      process.exit(1);
    }
    if (!opts.candidate?.length) {
      console.error("At least one --candidate is required");
      process.exit(1);
    }

    const baselineFiles = collectFiles(opts.baseline);
    if (baselineFiles.length === 0) {
      console.error("No baseline files found");
      process.exit(1);
    }

    // Parse candidates: each -c value could be a directory or file
    // Group by directory name for labeling
    const candidates = new Map<string, string[]>();
    for (const path of opts.candidate) {
      const files = collectFiles([path]);
      if (files.length === 0) continue;
      const label = basename(path.replace(/\/$/, ""));
      const existing = candidates.get(label) || [];
      existing.push(...files);
      candidates.set(label, existing);
    }

    if (candidates.size === 0) {
      console.error("No candidate files found");
      process.exit(1);
    }

    const { buildAnalysis } = await import("./lib/analysis.js");
    const analysis = await buildAnalysis(baselineFiles, candidates, {
      noiseThreshold: parseFloat(opts.noise),
      maxDepth: parseInt(opts.depth),
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(analysis, null, 2) + "\n");
    } else {
      const { renderAnalysis } = await import("./analyze.js");
      const output = renderAnalysis(analysis, opts.verbose, 0, parseInt(opts.depth));
      process.stderr.write(output + "\n");
    }
  });

program.parse();
