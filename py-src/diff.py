"""Differential flamegraph via the microprofiler's DiffSides API."""

from __future__ import annotations

import base64
import time
from pathlib import Path

import click


def diff(
    baseline_files: list[Path],
    candidate_files: list[Path],
    output_path: Path,
    timeout: int = 60000,
) -> None:
    """Produce a differential flamegraph HTML comparing baseline vs candidate dumps.

    Uses the microprofiler viewer's built-in DiffSides system which handles
    multi-dump aggregation, thread-aware comparison, and d3-flamegraph rendering.
    """
    from extractor.viewer import close_viewer, load_viewer

    if not baseline_files:
        raise click.ClickException("No baseline files provided")
    if not candidate_files:
        raise click.ClickException("No candidate files provided")

    click.echo(f"Loading viewer with {baseline_files[0].name}...", err=True)
    browser, page = load_viewer(baseline_files[0], timeout=timeout)

    try:
        page.evaluate("() => InitDiffSides()")

        for f in baseline_files[1:]:
            _add_file_to_side(page, 0, f)
            click.echo(f"  baseline: {f.name}", err=True)

        for f in candidate_files:
            _add_file_to_side(page, 1, f)
            click.echo(f"  candidate: {f.name}", err=True)

        page.evaluate("""() => {
            window._diffResult = null;
            window._origSaveExportResult = window.SaveExportResult;
            window.SaveExportResult = (data, filename, mimeType) => {
                window._diffResult = data;
            };
        }""")

        click.echo("Exporting diff...", err=True)
        page.evaluate("() => ExportDiffSides(-1)")

        deadline = time.time() + timeout / 1000
        while time.time() < deadline:
            result = page.evaluate("() => window._diffResult")
            if result is not None:
                break
            time.sleep(1)
        else:
            raise click.ClickException("Diff export timed out")

        page.evaluate("() => { window.SaveExportResult = window._origSaveExportResult; }")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(result)

        size_kb = len(result) / 1024
        click.echo(f"Diff → {output_path} ({size_kb:.0f} KB)", err=True)

    finally:
        close_viewer(browser, page)


def _add_file_to_side(page, side_id: int, file_path: Path) -> None:
    """Add a .raw or .html file to a diff side via JS File API."""
    raw_bytes = file_path.read_bytes()
    b64 = base64.b64encode(raw_bytes).decode()

    page.evaluate(
        """([sideId, b64Data, fileName]) => {
        const bytes = Uint8Array.from(atob(b64Data), c => c.charCodeAt(0));
        const file = new File([bytes], fileName, {type: "application/octet-stream"});
        AddToDiffSide(sideId, file);
    }""",
        [side_id, b64, file_path.name],
    )
