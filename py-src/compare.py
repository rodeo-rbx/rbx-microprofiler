"""Compare two sets of microprofiler dumps — Bench-style tree with per-frame stats.

Uses Perfetto SQL for hierarchy reconstruction and per-occurrence statistics.
Tree structure matches the microprofiler's diff flamegraph exactly (verified).
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import click
import numpy as np

# Filter out idle/scheduling slices at root that the microprofiler omits
ROOT_FILTER = {"Sleep", "Sched"}

STAT_KEYS = ["avg", "p50", "p90", "min", "max", "mad"]

# Hierarchical query: build parent-child tree from slice table
TREE_QUERY = """
SELECT
    s.id,
    s.parent_id,
    s.name,
    s.dur,
    s.depth,
    COALESCE(t.name, 'Thread ' || tt.utid) as thread_name
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.id
WHERE s.dur > 0
ORDER BY s.ts
"""


def compare(
    baseline_files: list[Path],
    candidate_files: list[Path],
    min_ms: float = 0,
    max_depth: int = 999,
    output_path: Path | None = None,
) -> None:
    """Compare two sets of dumps with Bench-style per-frame stats."""
    from extractor.terminal import DiffNode, print_diff_tree

    click.echo("Processing baseline dumps...", err=True)
    baseline_stats = _compute_stats(baseline_files)

    click.echo("Processing candidate dumps...", err=True)
    candidate_stats = _compute_stats(candidate_files)

    click.echo("Building comparison tree...", err=True)
    baseline_tree = _build_hierarchy(baseline_files)
    candidate_tree = _build_hierarchy(candidate_files)

    nodes = _merge_trees(baseline_tree, candidate_tree, baseline_stats, candidate_stats, max_depth)

    title = f"Comparison ({len(baseline_files)} baseline vs {len(candidate_files)} candidate dumps)"
    print_diff_tree(nodes, title=title, min_ms=min_ms, output_path=output_path)


def _extract_single_dump(file_path: Path) -> dict[str, list[float]]:
    """Extract per-name durations from a single dump. Runs in a worker process."""
    from extractor.extract import extract_perfetto

    tmp = tempfile.NamedTemporaryFile(suffix=".perfetto-trace", delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)

    try:
        extract_perfetto([file_path], tmp_path)

        from perfetto.trace_processor import TraceProcessor

        tp = TraceProcessor(trace=str(tmp_path))
        result = tp.query("""
            SELECT name, CAST(dur AS REAL) / 1e6 as dur_ms
            FROM slice WHERE dur > 0
        """)
        df = result.as_pandas_dataframe()
        tp.close()

        # Return raw durations grouped by name
        durations: dict[str, list[float]] = {}
        for name in df["name"].unique():
            if not isinstance(name, str):
                continue
            durations[name] = df[df["name"] == name]["dur_ms"].tolist()
        return durations
    finally:
        import os
        os.unlink(str(tmp_path))


def _compute_stats(files: list[Path]) -> dict[str, dict]:
    """Extract and merge stats from all dumps in parallel."""
    from concurrent.futures import ThreadPoolExecutor
    import os

    max_workers = min(os.cpu_count() or 4, len(files))
    click.echo(f"  extracting {len(files)} dumps ({max_workers} workers)...", err=True)

    # Parallel extraction
    all_durations: dict[str, list[float]] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_extract_single_dump, f): f for f in files}
        for future in futures:
            durations = future.result()
            for name, values in durations.items():
                all_durations.setdefault(name, []).extend(values)

    # Compute aggregate stats from merged durations
    stats = {}
    for name, values_list in all_durations.items():
        values = np.array(values_list)
        if len(values) == 0:
            continue
        avg = float(np.mean(values))
        median = float(np.median(values))
        stats[name] = {
            "avg": avg,
            "p10": float(np.percentile(values, 10)),
            "p50": median,
            "p90": float(np.percentile(values, 90)),
            "min": float(np.min(values)),
            "max": float(np.max(values)),
            "mad": float(np.median(np.abs(values - median))),
            "cv": float(np.std(values) / avg * 100) if avg > 0 else 0,
            "count": len(values),
        }
    return stats


def _build_hierarchy(files: list[Path]) -> dict:
    """Build a tree hierarchy from the first dump's Perfetto data.

    Returns {name: {children: {name: {...}}, total_ms: float}}.
    """
    from extractor.extract import extract_perfetto
    from perfetto.trace_processor import TraceProcessor

    tmp = tempfile.NamedTemporaryFile(suffix=".perfetto-trace", delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)

    try:
        # Use first file only for hierarchy (all dumps share the same structure)
        extract_perfetto([files[0]], tmp_path)

        tp = TraceProcessor(trace=str(tmp_path))
        result = tp.query(TREE_QUERY)
        df = result.as_pandas_dataframe()
        tp.close()

        # Build parent→children map
        children_of: dict[int | None, list] = {}
        node_info: dict[int, dict] = {}
        for _, row in df.iterrows():
            nid = int(row["id"])
            pid = int(row["parent_id"]) if row["parent_id"] is not None and not np.isnan(row["parent_id"]) else None
            name = row["name"]
            dur = float(row["dur"]) / 1e6  # ns → ms

            node_info[nid] = {"name": name, "dur": dur, "depth": int(row["depth"])}
            children_of.setdefault(pid, []).append(nid)

        # Build tree from roots (depth=0), filtering Sleep/Sched
        tree = {}
        for root_id in children_of.get(None, []):
            info = node_info[root_id]
            if info["name"] in ROOT_FILTER:
                continue
            _add_to_tree(tree, root_id, node_info, children_of)

        return tree
    finally:
        import os
        os.unlink(str(tmp_path))


def _add_to_tree(tree: dict, node_id: int, node_info: dict, children_of: dict) -> None:
    """Recursively add a node and its children to the tree, aggregating by name."""
    info = node_info[node_id]
    name = info["name"]

    if name not in tree:
        tree[name] = {"total_ms": 0, "children": {}}

    tree[name]["total_ms"] += info["dur"]

    for child_id in children_of.get(node_id, []):
        child_info = node_info[child_id]
        if child_info["name"] in ROOT_FILTER:
            continue
        _add_to_tree(tree[name]["children"], child_id, node_info, children_of)


def _merge_trees(
    baseline_tree: dict,
    candidate_tree: dict,
    baseline_stats: dict[str, dict],
    candidate_stats: dict[str, dict],
    max_depth: int,
    depth: int = 0,
) -> list:
    """Merge two hierarchy trees into DiffNode list with per-frame stats."""
    from extractor.terminal import DiffNode

    all_names = sorted(
        set(baseline_tree) | set(candidate_tree),
        key=lambda n: -(
            baseline_tree.get(n, {}).get("total_ms", 0)
            + candidate_tree.get(n, {}).get("total_ms", 0)
        ),
    )

    nodes = []
    for name in all_names:
        b_node = baseline_tree.get(name, {"total_ms": 0, "children": {}})
        c_node = candidate_tree.get(name, {"total_ms": 0, "children": {}})

        # Stat rows from per-occurrence Perfetto data
        stat_children = []
        bs = baseline_stats.get(name, {})
        cs = candidate_stats.get(name, {})
        if bs or cs:
            for key in STAT_KEYS:
                bv = bs.get(key, 0)
                cv = cs.get(key, 0)
                stat_children.append(DiffNode(
                    name=key,
                    baseline_ms=bv,
                    candidate_ms=cv,
                    children=[],
                    is_stat=True,
                ))

        # Recurse into tree children
        tree_children = []
        if depth < max_depth:
            tree_children = _merge_trees(
                b_node.get("children", {}),
                c_node.get("children", {}),
                baseline_stats,
                candidate_stats,
                max_depth,
                depth + 1,
            )

        nodes.append(DiffNode(
            name=name,
            baseline_ms=b_node["total_ms"],
            candidate_ms=c_node["total_ms"],
            children=stat_children + tree_children,
        ))

    return nodes
