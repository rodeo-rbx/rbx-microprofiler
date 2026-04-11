from __future__ import annotations

from pathlib import Path

import subprocess
import sys

import click

SUPPORTED_INPUTS = {".html", ".raw"}
SUPPORTED_OUTPUTS = {".html", ".raw", ".perfetto-trace", ".json"}

EXTENSION_MAP = {
    ".perfetto-trace": "perfetto",
    ".json": "json",
    ".html": "html",
    ".raw": "raw",
}


def _open_file(path: Path) -> None:
    """Open a file with the system default application."""
    if sys.platform == "darwin":
        subprocess.run(["open", str(path)])
    elif sys.platform == "linux":
        subprocess.run(["xdg-open", str(path)])
    else:
        subprocess.run(["start", str(path)], shell=True)


def _collect_files(paths: tuple[Path, ...]) -> list[Path]:
    """Expand directories into their .raw/.html contents."""
    files = []
    for p in paths:
        if p.is_dir():
            files.extend(sorted(f for f in p.iterdir() if f.suffix in SUPPORTED_INPUTS))
        else:
            files.append(p)
    return files


@click.group()
def cli():
    """Roblox MicroProfiler CLI — flamegraphs, diffs, summaries, and format conversion."""
    pass


@cli.command()
@click.argument("input_files", nargs=-1, required=True, type=click.Path(exists=True, path_type=Path))
@click.argument("output_file", type=click.Path(path_type=Path))
@click.option("--timeout", type=int, default=60000, help="Page load timeout in ms (default: 60000)")
def convert(input_files: tuple[Path, ...], output_file: Path, timeout: int):
    """Convert between MicroProfiler formats.

    Accepts one or more input files. Multiple inputs are merged into a single output
    (supported for .perfetto-trace and .json output).

    \b
    Examples:
      rbx-microprofiler convert dump.raw dump.html
      rbx-microprofiler convert dump.raw dump.perfetto-trace
      rbx-microprofiler convert dumps/*.raw merged.perfetto-trace
      rbx-microprofiler convert dump.html dump.raw
    """
    from extractor.extract import (
        extract_perfetto,
        extract_trace_json,
        html_to_raw,
        raw_to_html,
    )

    inputs = [p.resolve() for p in input_files]
    output_file = output_file.resolve()

    in_ext = inputs[0].suffix
    if inputs[0].name.endswith(".perfetto-trace"):
        in_ext = ".perfetto-trace"
    out_ext = ".perfetto-trace" if output_file.name.endswith(".perfetto-trace") else output_file.suffix

    if in_ext not in SUPPORTED_INPUTS:
        raise click.ClickException(
            f"Unsupported input format: {in_ext}\n"
            f"Supported: {', '.join(sorted(SUPPORTED_INPUTS))}"
        )

    if out_ext not in SUPPORTED_OUTPUTS:
        raise click.ClickException(
            f"Unsupported output format: {out_ext}\n"
            f"Supported: {', '.join(sorted(SUPPORTED_OUTPUTS))}"
        )

    if in_ext == out_ext:
        raise click.ClickException("Input and output formats are the same")

    if len(inputs) > 1 and out_ext not in (".perfetto-trace", ".json"):
        raise click.ClickException(f"Multiple inputs only supported for .perfetto-trace and .json output")

    out_fmt = EXTENSION_MAP[out_ext]

    if out_fmt == "html":
        if in_ext == ".raw":
            raw_to_html(inputs[0], output_file)
        else:
            raise click.ClickException(f"Cannot convert {in_ext} → {out_ext}")
    elif out_fmt == "raw":
        if in_ext == ".html":
            html_to_raw(inputs[0], output_file)
        else:
            raise click.ClickException(f"Cannot convert {in_ext} → {out_ext}")
    elif out_fmt == "perfetto":
        extract_perfetto(inputs, output_file, timeout=timeout)
    elif out_fmt == "json":
        extract_trace_json(inputs[0], output_file, timeout=timeout)


@cli.command()
@click.argument("files", nargs=-1, required=True, type=click.Path(exists=True, path_type=Path))
@click.option("-o", "--output", required=True, type=click.Path(path_type=Path), help="Output HTML file")
@click.option("--timeout", type=int, default=60000, help="Page load timeout in ms")
@click.option("--open", "open_file", is_flag=True, default=False, help="Open output in default app")
def flamegraph(files: tuple[Path, ...], output: Path, timeout: int, open_file: bool):
    """Generate an interactive flamegraph from one or more dumps.

    Accepts .raw or .html files, or directories containing them.
    Multiple files are merged into a single flamegraph.

    \b
    Examples:
      rbx-microprofiler flamegraph dump.raw -o flamegraph.html
      rbx-microprofiler flamegraph profiles/bulkmoveto/ -o flamegraph.html
      rbx-microprofiler flamegraph *.raw -o flamegraph.html
    """
    from extractor.viewer import close_viewer, load_viewer

    all_files = _collect_files(files)
    if not all_files:
        raise click.ClickException("No .raw or .html files found")

    click.echo(f"Loading {len(all_files)} dump(s)...", err=True)
    browser, page = load_viewer(all_files[0], timeout=timeout)

    try:
        # For single-file flamegraph, use ExportDiffSides with only side 0
        # (this triggers the flamegraph export path)
        page.evaluate("() => InitDiffSides()")

        # Add remaining files to side 0
        import base64
        for f in all_files[1:]:
            raw_bytes = f.read_bytes()
            b64 = base64.b64encode(raw_bytes).decode()
            page.evaluate(
                """([b64Data, fileName]) => {
                const bytes = Uint8Array.from(atob(b64Data), c => c.charCodeAt(0));
                const file = new File([bytes], fileName);
                AddToDiffSide(0, file);
            }""",
                [b64, f.name],
            )
            click.echo(f"  added: {f.name}", err=True)

        # Override SaveExportResult to capture
        page.evaluate("""() => {
            window._exportResult = null;
            window.SaveExportResult = (data) => { window._exportResult = data; };
        }""")

        click.echo("Exporting flamegraph...", err=True)
        page.evaluate("() => ExportDiffSides(0)")  # side 0 only = single flamegraph

        import time
        deadline = time.time() + timeout / 1000
        while time.time() < deadline:
            result = page.evaluate("() => window._exportResult")
            if result is not None:
                break
            time.sleep(1)
        else:
            raise click.ClickException("Flamegraph export timed out")

        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(result)
        size_kb = len(result) / 1024
        click.echo(f"Flamegraph → {output} ({size_kb:.0f} KB)", err=True)

        if open_file:
            _open_file(output)

    finally:
        close_viewer(browser, page)


@cli.command()
@click.option("--baseline", "-b", multiple=True, required=True, type=click.Path(exists=True, path_type=Path),
              help="Baseline dump files or directories")
@click.option("--candidate", "-c", multiple=True, required=True, type=click.Path(exists=True, path_type=Path),
              help="Candidate dump files or directories")
@click.option("-o", "--output", required=True, type=click.Path(path_type=Path), help="Output HTML file")
@click.option("--timeout", type=int, default=120000, help="Timeout in ms (default: 120000)")
@click.option("--open", "open_file", is_flag=True, default=False, help="Open output in default app")
def diff(baseline: tuple[Path, ...], candidate: tuple[Path, ...], output: Path, timeout: int, open_file: bool):
    """Generate a differential flamegraph comparing baseline vs candidate dumps.

    Accepts .raw or .html files, or directories. Multiple files per side
    are merged automatically by the microprofiler's viewer.

    \b
    Examples:
      rbx-microprofiler diff -b profiles/bulkmoveto/ -c profiles/motor6d/ -o diff.html
      rbx-microprofiler diff -b base.raw -c candidate.raw -o diff.html
      rbx-microprofiler diff -b base1.raw -b base2.raw -c cand1.raw -c cand2.raw -o diff.html
    """
    from extractor.diff import diff as do_diff

    baseline_files = _collect_files(baseline)
    candidate_files = _collect_files(candidate)

    do_diff(baseline_files, candidate_files, output.resolve(), timeout=timeout)

    if open_file:
        _open_file(output.resolve())


@cli.command()
@click.argument("files", nargs=-1, required=True, type=click.Path(exists=True, path_type=Path))
@click.option("--timeout", type=int, default=60000, help="Page load timeout in ms")
def summary(files: tuple[Path, ...], timeout: int):
    """Print a JSON summary of microprofiler dump(s).

    Outputs frame stats, timer breakdown, and CPU/GPU classification to stdout.

    \b
    Examples:
      rbx-microprofiler summary dump.raw
      rbx-microprofiler summary profiles/bulkmoveto/
    """
    from extractor.viewer import call_export_summary, close_viewer, load_viewer

    all_files = _collect_files(files)
    if not all_files:
        raise click.ClickException("No .raw or .html files found")

    click.echo(f"Loading {len(all_files)} dump(s)...", err=True)
    browser, page = load_viewer(all_files[0], timeout=timeout)

    try:
        result = call_export_summary(page)
        if result:
            click.echo(result)
        else:
            raise click.ClickException("ExportSummaryJSON returned no data")
    finally:
        close_viewer(browser, page)


@cli.command()
@click.option("--baseline", "-b", multiple=True, required=True, type=click.Path(exists=True, path_type=Path),
              help="Baseline dump files or directories")
@click.option("--candidate", "-c", multiple=True, required=True, type=click.Path(exists=True, path_type=Path),
              help="Candidate dump files or directories")
@click.option("-o", "--output", type=click.Path(path_type=Path), default=None, help="Write output to file instead of stderr")
@click.option("--min-ms", type=float, default=0, help="Hide entries below this threshold (default: 0)")
@click.option("--depth", type=int, default=999, help="Max tree depth (default: unlimited)")
def compare(baseline: tuple[Path, ...], candidate: tuple[Path, ...], output: Path | None, min_ms: float, depth: int):
    """Compare two sets of dumps with Bench-style per-frame statistics.

    Produces a hierarchical tree with per-occurrence stats (avg/p50/p90/min/max/MAD)
    for each subsystem. Tree structure matches the microprofiler's diff flamegraph.

    \b
    Examples:
      rbx-microprofiler compare -b profiles/bulkmoveto/ -c profiles/motor6d/
      rbx-microprofiler compare -b baseline/ -c candidate/ -o report.txt
      rbx-microprofiler compare --min-ms 0.1 --depth 8 -b baseline/ -c candidate/
    """
    from extractor.compare import compare as do_compare

    baseline_files = _collect_files(baseline)
    candidate_files = _collect_files(candidate)

    if not baseline_files:
        raise click.ClickException("No baseline files found")
    if not candidate_files:
        raise click.ClickException("No candidate files found")

    do_compare(baseline_files, candidate_files, min_ms=min_ms, max_depth=depth, output_path=output)


@cli.command()
@click.argument("files", nargs=-1, required=True, type=click.Path(exists=True, path_type=Path))
@click.option("-o", "--output", required=True, type=click.Path(path_type=Path), help="Output CSV file")
@click.option("--counters", is_flag=True, default=False, help="Export counters instead of markers")
@click.option("--timeout", type=int, default=60000, help="Page load timeout in ms")
@click.option("--open", "open_file", is_flag=True, default=False, help="Open output in default app")
def csv(files: tuple[Path, ...], output: Path, counters: bool, timeout: int, open_file: bool):
    """Export frame markers or performance counters as CSV.

    \b
    Examples:
      rbx-microprofiler csv dump.raw -o markers.csv
      rbx-microprofiler csv --counters dump.raw -o counters.csv
    """
    from extractor.viewer import (
        call_export_counters_csv,
        call_export_markers_csv,
        close_viewer,
        load_viewer,
    )

    all_files = _collect_files(files)
    if not all_files:
        raise click.ClickException("No .raw or .html files found")

    click.echo(f"Loading {len(all_files)} dump(s)...", err=True)
    browser, page = load_viewer(all_files[0], timeout=timeout)

    try:
        if counters:
            result = call_export_counters_csv(page)
        else:
            result = call_export_markers_csv(page)

        if result:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(result)
            click.echo(f"CSV → {output}", err=True)
            if open_file:
                _open_file(output)
        else:
            export_type = "counters" if counters else "markers"
            raise click.ClickException(f"Export{export_type.title()}CSV returned no data")
    finally:
        close_viewer(browser, page)
