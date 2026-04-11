from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import click

BATCH_SIZE = 20

# Returns raw event data as JSON string (array of {ph, ts, tid, name, cat, ...})
JS_EXTRACT_BATCH = """(args) => {
    const [startIdx, endIdx] = args;
    const frames = window._nonNullFrames;
    const timerNames = window._timerNames;
    const timerCats = window._timerCats;
    const timerIds = window._timerIds;
    const parts = [];

    for (let fi = startIdx; fi < endIdx && fi < frames.length; fi++) {
        const frame = frames[fi];
        for (let tid = 0; tid < frame.ts.length; tid++) {
            const ts = frame.ts[tid];
            const tt = frame.tt[tid];
            const ti = frame.ti[tid];
            const tl = frame.tl[tid];
            if (!ts || ts.length === 0) continue;

            for (let i = 0; i < ts.length; i++) {
                const type = tt[i];
                if (type >= 128) continue;

                let ph;
                if (type === 1) ph = "B";
                else if (type === 0) ph = "E";
                else if (type === 3) ph = "i";
                else continue;

                const tsMs = Number(ts[i]);
                const timerIdx = ti[i];
                const name = timerNames[timerIdx] || "(unknown)";
                const cat = timerCats[timerIdx] || "";

                const timerId = timerIds[timerIdx] || timerIdx;
                let line = '{"ph":"' + ph + '","ts":' + tsMs + ',"tid":' + tid + ',"name":' + JSON.stringify(name) + ',"cat":' + JSON.stringify(cat) + ',"timer_id":' + timerId;

                if (tl && tl[i]) {
                    line += ',"label":' + JSON.stringify(tl[i]);
                }

                line += '}';
                parts.push(line);
            }
        }
    }

    return '[' + parts.join(',') + ']';
}"""

JS_INIT = """() => {
    window._nonNullFrames = window.Frames.filter(f => f != null);

    const threads = [];
    for (let i = 0; i < window.ThreadNames.length; i++) {
        const name = window.ThreadNames[i];
        if (name && name.trim()) {
            threads.push({ tid: i, name: name.trim() });
        }
    }

    // Pre-compute timer lookup arrays.
    // Names are kept plain — uniqueness is via timer_id in event args.
    // Category (group name) is a separate field for filtering/grouping.
    const timerInfo = window.TimerInfo;
    const groupInfo = window.GroupInfo;

    window._timerNames = new Array(timerInfo.length);
    window._timerCats = new Array(timerInfo.length);
    window._timerIds = new Array(timerInfo.length);
    for (let i = 0; i < timerInfo.length; i++) {
        const t = timerInfo[i];
        if (!t) continue;
        const groupName = (t.group < groupInfo.length && groupInfo[t.group])
            ? groupInfo[t.group].name : "";
        window._timerNames[i] = t.name;
        window._timerCats[i] = groupName;
        window._timerIds[i] = t.id;
    }

    return {
        frameCount: window._nonNullFrames.length,
        threadCount: window.ThreadNames.length,
        threads: threads,
    };
}"""


TEMPLATE_PATH = Path(__file__).resolve().parent.parent.parent / "template.html"


def _encode_raw_payload(raw_data: bytes) -> str:
    """Encode raw binary payload as base64 HTML comment data.

    Returns the base64 string (without <!-- --> wrapper).
    """
    import base64
    import struct
    import zlib

    if len(raw_data) < 8:
        raise click.ClickException(f"Raw file too small: {len(raw_data)} bytes")
    payload = raw_data[8:]  # skip 4 zero bytes + R0FL magic
    compressed = zlib.compress(payload)
    header = b"GAK" + struct.pack("<I", len(payload)) + struct.pack("<I", len(compressed))
    return base64.b64encode(header + compressed).decode("ascii")


def _get_template_parts() -> tuple[str, str]:
    """Return (parser_comment, viewer_html) from the template file.

    Template structure: line 1 = data comment, line 2 = JS parser comment, line 3+ = HTML viewer.
    """
    if not TEMPLATE_PATH.exists():
        raise click.ClickException(f"Viewer template not found at {TEMPLATE_PATH}")
    with open(TEMPLATE_PATH) as f:
        lines = f.readlines()
    parser_comment = lines[1]  # JS WASM parser module
    viewer_html = "".join(lines[2:])
    return parser_comment, viewer_html


def _raw_to_html(raw_path: Path) -> Path:
    """Convert a .raw dump to a temporary .html file for Chromium extraction."""
    import tempfile

    b64 = _encode_raw_payload(raw_path.read_bytes())
    parser_comment, viewer_html = _get_template_parts()

    tmp = tempfile.NamedTemporaryFile(suffix=".html", delete=False)
    tmp.write(f"<!--{b64}-->\n".encode())
    tmp.write(parser_comment.encode())
    tmp.write(viewer_html.encode())
    tmp.close()

    click.echo(f"Converted {raw_path.name} → temp HTML", err=True)
    return Path(tmp.name)


def raw_to_html(raw_path: Path, output_path: Path) -> None:
    """Convert a .raw MicroProfiler dump to a standalone .html viewer file."""
    b64 = _encode_raw_payload(raw_path.read_bytes())
    parser_comment, viewer_html = _get_template_parts()

    with open(output_path, "w") as f:
        f.write(f"<!--{b64}-->\n")
        f.write(parser_comment)
        f.write(viewer_html)

    size_mb = output_path.stat().st_size / (1024 * 1024)
    click.echo(f"{raw_path.name} → {output_path.name} ({size_mb:.1f} MB)", err=True)


def html_to_raw(html_path: Path, output_path: Path) -> None:
    """Extract the binary .raw data from a MicroProfiler .html dump."""
    import base64
    import struct
    import zlib

    with open(html_path) as f:
        line1 = f.readline().strip()

    if not line1.startswith("<!--") or not line1.endswith("-->"):
        raise click.ClickException("HTML file does not start with a data comment")

    b64data = line1[4:-3]
    decoded = base64.b64decode(b64data)

    if decoded[:3] != b"GAK":
        raise click.ClickException(f"Unexpected data header: {decoded[:3]!r} (expected GAK)")

    uncomp_size = struct.unpack("<I", decoded[3:7])[0]
    payload = zlib.decompress(decoded[11:])

    if len(payload) != uncomp_size:
        raise click.ClickException(
            f"Decompressed size mismatch: got {len(payload)}, expected {uncomp_size}"
        )

    raw_data = b"\x00\x00\x00\x00R0FL" + payload
    output_path.write_bytes(raw_data)

    size_mb = len(raw_data) / (1024 * 1024)
    click.echo(f"{html_path.name} → {output_path.name} ({size_mb:.1f} MB)", err=True)


def ensure_chromium() -> None:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            p.chromium.executable_path  # noqa: B018
    except Exception:
        click.echo("Installing Playwright Chromium...", err=True)
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            check=True,
        )


def _load_page(dump_path: Path, timeout: int):
    """Open dump in headless Chromium, wait for WASM parser, return (page, browser, playwright).

    Accepts both .html and .raw files. Raw files are converted to a temp HTML first.
    """
    from playwright.sync_api import sync_playwright

    # Convert .raw to temp .html if needed
    tmp_html = None
    if dump_path.suffix == ".raw":
        tmp_html = _raw_to_html(dump_path)
        load_path = tmp_html
    else:
        load_path = dump_path

    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page()

    click.echo(f"Loading {load_path.name}...", err=True)
    page.goto(load_path.as_uri(), wait_until="load", timeout=timeout)

    click.echo("Waiting for WASM parser...", err=True)
    page.wait_for_function(
        "() => window.TimerInfo && window.TimerInfo.length > 0",
        timeout=30000,
    )

    click.echo("Waiting for frame data...", err=True)
    page.wait_for_function(
        "() => window.Frames && window.Frames.filter(f => f != null).length > 0",
        timeout=30000,
    )

    return page, browser, pw


def _load_page_reuse(dump_path: Path, browser, timeout: int):
    """Open dump in an existing browser, wait for WASM parser, return page."""
    import os

    tmp_html = None
    if dump_path.suffix == ".raw":
        tmp_html = _raw_to_html(dump_path)
        load_path = tmp_html
    else:
        load_path = dump_path

    page = browser.new_page()
    page.goto(load_path.as_uri(), wait_until="load", timeout=timeout)

    page.wait_for_function(
        "() => window.TimerInfo && window.TimerInfo.length > 0",
        timeout=30000,
    )
    page.wait_for_function(
        "() => window.Frames && window.Frames.filter(f => f != null).length > 0",
        timeout=30000,
    )

    # Clean up temp file
    if tmp_html:
        os.unlink(str(tmp_html))

    return page


def _extract_raw_events(page, total_frames: int):
    """Yield batches of raw event dicts from the browser."""
    for start in range(0, total_frames, BATCH_SIZE):
        end = min(start + BATCH_SIZE, total_frames)
        chunk_json = page.evaluate(JS_EXTRACT_BATCH, [start, end])
        events = json.loads(chunk_json)
        click.echo(f"  frames {start}-{end}: {len(events)} events", err=True)
        yield events


def extract_perfetto(dump_paths: Path | list[Path], output_path: Path, *, timeout: int = 60000) -> None:
    """Extract one or more dumps to a single Perfetto protobuf trace (.perfetto-trace).

    When multiple dumps are provided, all events are merged into one trace
    with their original timestamps preserved.
    """
    from perfetto.protos.perfetto.trace.perfetto_trace_pb2 import TrackEvent
    from perfetto.trace_builder.proto_builder import StreamingTraceProtoBuilder

    if isinstance(dump_paths, Path):
        dump_paths = [dump_paths]

    ensure_chromium()

    PROCESS_UUID = 1
    SEQUENCE_ID = 1
    STATE_CLEAR_INTERVAL = 5000

    with open(output_path, "wb") as f:
        builder = StreamingTraceProtoBuilder(f)

        # Process descriptor — single Roblox process
        pkt = builder.create_packet()
        pkt.trusted_packet_sequence_id = SEQUENCE_ID
        pkt.track_descriptor.uuid = PROCESS_UUID
        pkt.track_descriptor.process.pid = 1
        pkt.track_descriptor.process.process_name = "Roblox"
        builder.write_packet(pkt)

        # Shared state across all dumps
        thread_uuids: dict[int, int] = {}
        name_to_iid: dict[str, int] = {}
        cat_to_iid: dict[str, int] = {}
        next_name_iid = 1
        next_cat_iid = 1
        total_events = 0
        events_since_clear = STATE_CLEAR_INTERVAL

        for dump_idx, dump_path in enumerate(dump_paths):
            click.echo(f"[{dump_idx + 1}/{len(dump_paths)}] {dump_path.name}", err=True)
            page, browser, pw = _load_page(dump_path, timeout)

            meta = page.evaluate(JS_INIT)
            total_frames = meta["frameCount"]
            click.echo(f"  {total_frames} frames, {meta['threadCount']} threads", err=True)

            # Register any new threads from this dump
            for thread in meta["threads"]:
                tid = thread["tid"]
                if tid not in thread_uuids:
                    uuid = tid + 100
                    thread_uuids[tid] = uuid
                    pkt = builder.create_packet()
                    pkt.trusted_packet_sequence_id = SEQUENCE_ID
                    pkt.track_descriptor.uuid = uuid
                    pkt.track_descriptor.parent_uuid = PROCESS_UUID
                    pkt.track_descriptor.thread.pid = 1
                    pkt.track_descriptor.thread.tid = tid
                    pkt.track_descriptor.thread.thread_name = thread["name"]
                    builder.write_packet(pkt)

            for batch in _extract_raw_events(page, total_frames):
                for evt in batch:
                    tid = evt["tid"]
                    uuid = thread_uuids.get(tid)
                    if uuid is None:
                        uuid = tid + 100
                        thread_uuids[tid] = uuid
                        pkt = builder.create_packet()
                        pkt.trusted_packet_sequence_id = SEQUENCE_ID
                        pkt.track_descriptor.uuid = uuid
                        pkt.track_descriptor.parent_uuid = PROCESS_UUID
                        pkt.track_descriptor.thread.pid = 1
                        pkt.track_descriptor.thread.tid = tid
                        pkt.track_descriptor.thread.thread_name = f"Thread {tid}"
                        builder.write_packet(pkt)

                    ph = evt["ph"]
                    ts_ns = int(evt["ts"] * 1_000_000)
                    name = evt["name"]
                    cat = evt.get("cat", "")
                    timer_id = evt.get("timer_id", 0)

                    pkt = builder.create_packet()
                    pkt.trusted_packet_sequence_id = SEQUENCE_ID
                    pkt.timestamp = ts_ns

                    if ph == "B":
                        pkt.track_event.type = TrackEvent.TYPE_SLICE_BEGIN
                    elif ph == "E":
                        pkt.track_event.type = TrackEvent.TYPE_SLICE_END
                    elif ph == "i":
                        pkt.track_event.type = TrackEvent.TYPE_INSTANT
                    else:
                        continue

                    pkt.track_event.track_uuid = uuid

                    if ph != "E":
                        pkt.track_event.debug_annotations.add(
                            name="timer_id", int_value=timer_id
                        )

                    needs_clear = events_since_clear >= STATE_CLEAR_INTERVAL
                    if needs_clear:
                        pkt.sequence_flags = 1
                        for n, iid in name_to_iid.items():
                            pkt.interned_data.event_names.add(iid=iid, name=n)
                        for c, iid in cat_to_iid.items():
                            pkt.interned_data.event_categories.add(iid=iid, name=c)
                        events_since_clear = 0
                    else:
                        pkt.sequence_flags = 2

                    if ph != "E":
                        new_name = name not in name_to_iid
                        if new_name:
                            name_to_iid[name] = next_name_iid
                            next_name_iid += 1
                        iid = name_to_iid[name]
                        if new_name and not needs_clear:
                            pkt.interned_data.event_names.add(iid=iid, name=name)
                        pkt.track_event.name_iid = iid

                    if cat and ph != "E":
                        new_cat = cat not in cat_to_iid
                        if new_cat:
                            cat_to_iid[cat] = next_cat_iid
                            next_cat_iid += 1
                        iid = cat_to_iid[cat]
                        if new_cat and not needs_clear:
                            pkt.interned_data.event_categories.add(iid=iid, name=cat)
                        pkt.track_event.category_iids.append(iid)

                    total_events += 1
                    events_since_clear += 1
                    builder.write_packet(pkt)

            browser.close()
            pw.stop()

    size_mb = output_path.stat().st_size / (1024 * 1024)
    click.echo(f"Total: {total_events} events → {output_path} ({size_mb:.1f} MB)", err=True)


def extract_trace_json(dump_path: Path, output_path: Path | None, *, timeout: int = 60000) -> None:
    """Extract to Chrome Trace JSON format."""
    ensure_chromium()
    page, browser, pw = _load_page(dump_path, timeout)

    meta = page.evaluate(JS_INIT)
    total_frames = meta["frameCount"]
    click.echo(
        f"Extracting {total_frames} frames across {meta['threadCount']} threads...",
        err=True,
    )

    # Build thread metadata JSON
    thread_meta_lines = []
    for thread in meta["threads"]:
        tid = thread["tid"]
        name = thread["name"]
        thread_meta_lines.append(
            f'{{"ph":"M","pid":0,"tid":{tid},"name":"thread_name","args":{{"name":{json.dumps(name)}}}}}'
        )

    out = open(output_path, "w") if output_path else sys.stdout
    try:
        out.write('{"traceEvents":[\n')
        out.write(",\n".join(thread_meta_lines))

        for batch in _extract_raw_events(page, total_frames):
            if batch:
                lines = []
                for evt in batch:
                    line = f'{{"ph":"{evt["ph"]}","ts":{evt["ts"] * 1000},"pid":0,"tid":{evt["tid"]},"name":{json.dumps(evt["name"])},"cat":{json.dumps(evt.get("cat", ""))}'
                    if evt["ph"] == "i":
                        line += ',"s":"t"'
                    label = evt.get("label")
                    if label:
                        line += f',"args":{{"label":{json.dumps(label)}}}'
                    line += "}"
                    lines.append(line)
                out.write(",\n")
                out.write(",\n".join(lines))

        out.write('\n],"displayTimeUnit":"ms"}\n')
    finally:
        if output_path:
            out.close()

    browser.close()
    pw.stop()

    if output_path:
        size_mb = output_path.stat().st_size / (1024 * 1024)
        click.echo(f"Written to {output_path} ({size_mb:.1f} MB)", err=True)
