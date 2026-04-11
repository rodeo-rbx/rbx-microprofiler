"""Shared headless Chromium loader for the Roblox MicroProfiler viewer.

Loads .raw/.html dump files into the microprofiler's WASM viewer,
providing access to its built-in APIs (flamegraph, diff, summary, CSV).
"""

from __future__ import annotations

from pathlib import Path

import click


def _resolve_html(file: Path) -> Path:
    """Ensure we have an .html file — convert .raw to temp .html if needed."""
    if file.suffix == ".html":
        return file
    elif file.suffix == ".raw":
        from extractor.extract import _raw_to_html
        return _raw_to_html(file)
    else:
        raise click.ClickException(f"Unsupported file type: {file.suffix}")


def load_viewer(base_file: Path, timeout: int = 60000):
    """Load a dump into the microprofiler viewer via headless Chromium.

    Args:
        base_file: The primary .raw or .html file to load
        timeout: Page load timeout in ms

    Returns:
        (browser, page) tuple — caller must close browser when done.
    """
    from extractor.extract import ensure_chromium
    ensure_chromium()

    from playwright.sync_api import sync_playwright

    html_path = _resolve_html(base_file)
    is_temp = html_path != base_file  # True if we created a temp .html

    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(f"file://{html_path}", timeout=timeout)

    # Wait for WASM parser to finish
    page.wait_for_function(
        "() => window.TimerInfo && window.TimerInfo.length > 0",
        timeout=timeout,
    )
    page.wait_for_function(
        "() => window.Frames && window.Frames.filter(f => f != null).length > 0",
        timeout=timeout,
    )

    # Store temp path for cleanup
    page._temp_html = html_path if is_temp else None
    page._pw = pw

    return browser, page


def close_viewer(browser, page):
    """Close the viewer and clean up temp files."""
    import os

    temp_path = getattr(page, "_temp_html", None)
    pw = getattr(page, "_pw", None)

    browser.close()
    if pw:
        pw.stop()

    if temp_path:
        try:
            os.unlink(str(temp_path))
        except OSError:
            pass


def call_export_summary(page) -> str:
    """Call ExportSummaryJSON and return the JSON string."""
    return page.evaluate("""() => {
        if (typeof ExportSummaryJSON !== 'function') return null;

        let captured = null;
        const origLog = console.log;
        console.log = (msg) => { captured = msg; };

        ExportSummaryJSON();

        console.log = origLog;
        return captured;
    }""")


def call_export_markers_csv(page) -> str:
    """Call ExportMarkersCSV and capture the output."""
    return page.evaluate("""() => {
        if (typeof ExportMarkersCSV !== 'function') return null;

        let captured = null;
        const origSave = window.SaveExportResult;
        window.SaveExportResult = (data) => { captured = data; };

        ExportMarkersCSV();

        window.SaveExportResult = origSave;
        return captured;
    }""")


def call_export_counters_csv(page) -> str:
    """Call ExportCountersCSV and capture the output."""
    return page.evaluate("""() => {
        if (typeof ExportCountersCSV !== 'function') return null;

        let captured = null;
        const origSave = window.SaveExportResult;
        window.SaveExportResult = (data) => { captured = data; };

        ExportCountersCSV();

        window.SaveExportResult = origSave;
        return captured;
    }""")
