"""Terminal rendering utilities — Bench-style tree output with rich.

Ports Bench's format_table for column-aligned stat rows and uses rich.Tree
for the hierarchical tree structure.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from rich.console import Console
from rich.text import Text
from rich.tree import Tree

# Scale thresholds: (threshold_ms, scale, unit, color)
SCALE_THRESHOLDS = [
    (1e6, 1e3, "s", "red"),
    (1e3, 1, "s", "yellow"),
    (1, 1, "ms", "green"),
    (1e-3, 1e-3, "µs", "yellow"),
    (0, 1e-6, "ns", "yellow"),
]

console = Console(stderr=True, width=300)

# ── ANSI helpers ──

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _visual_width(s: str) -> int:
    """Width of a string ignoring ANSI escape codes."""
    return len(_ANSI_RE.sub("", s))


def _pad(s: str, width: int, align: str = "left") -> str:
    """Pad a string (with ANSI) to a visual width."""
    vw = _visual_width(s)
    pad_needed = max(0, width - vw)
    if align == "right":
        return " " * pad_needed + s
    elif align == "center":
        left = pad_needed // 2
        right = pad_needed - left
        return " " * left + s + " " * right
    else:
        return s + " " * pad_needed


# ── ANSI color functions ──

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
WHITE = "\033[37m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
GRAY = "\033[90m"


def _color(text: str, code: str) -> str:
    return f"{code}{text}{RESET}"


def _bold(text: str) -> str:
    return f"{BOLD}{text}{RESET}"


def _color_for_ms(color_name: str) -> str:
    return {"red": RED, "yellow": YELLOW, "green": GREEN}.get(color_name, GREEN)


# ── Value formatting ──


def _format_scaled(value_ms: float) -> tuple[str, str, str]:
    """Return (number_str, unit, color_name) for a ms value."""
    abs_val = abs(value_ms)
    for threshold, scale, unit, color in SCALE_THRESHOLDS:
        if abs_val >= threshold or threshold == 0:
            scaled = value_ms / scale
            return f"{scaled:.3f}", unit, color
    return f"{value_ms:.3f}", "ms", "green"


def format_value_plain(value_ms: float) -> str:
    """Format ms value as plain string: '87.667 µs'."""
    num, unit, _ = _format_scaled(value_ms)
    return f"{num} {unit}"


def format_value_colored(value_ms: float) -> str:
    """Format ms value with ANSI color: '\033[33m87.667 µs\033[0m'."""
    num, unit, color = _format_scaled(value_ms)
    c = _color_for_ms(color)
    return f"{c}{num} {unit}{RESET}"


# ── Table formatter (ported from Bench's terminal.lua) ──


def format_table(
    rows: list[list[str]],
    justify_left: set[int] | None = None,
    justify_right: set[int] | None = None,
    margin_right: dict[int, int] | None = None,
) -> str:
    """Format rows into an aligned table string.

    Each row is a list of strings (may contain ANSI codes).
    Column widths are computed from visual width (ignoring ANSI).
    """
    if not rows:
        return ""

    justify_left = justify_left or set()
    justify_right = justify_right or set()
    margin_right = margin_right or {}

    num_cols = max(len(row) for row in rows)

    # Compute column widths
    col_widths = [0] * num_cols
    for row in rows:
        for col_idx in range(num_cols):
            cell = row[col_idx] if col_idx < len(row) else ""
            w = _visual_width(cell)
            if w > col_widths[col_idx]:
                col_widths[col_idx] = w

    # Render rows
    out_lines = []
    for row in rows:
        parts = []
        for col_idx in range(num_cols):
            cell = row[col_idx] if col_idx < len(row) else ""

            if col_idx in justify_right:
                align = "right"
            elif col_idx in justify_left:
                align = "left"
            else:
                align = "left"

            mr = margin_right.get(col_idx, 0)
            padded = _pad(cell, col_widths[col_idx], align)
            parts.append(padded + " " * mr)

        out_lines.append("".join(parts).rstrip())

    return "\n".join(out_lines)


# ── Stat row builder ──


def build_stat_rows(stats: list[tuple[str, float, float]]) -> str:
    """Build table-aligned stat rows for a node.

    Args:
        stats: list of (name, baseline_ms, candidate_ms)

    Returns:
        Multi-line string with aligned columns, each line prefixed with "│ ".
    """
    rows: list[list[str]] = []
    for name, baseline_ms, candidate_ms in stats:
        delta = candidate_ms - baseline_ms

        if delta > 0:
            d_color = RED
            ratio_label = "slower"
        elif delta < 0:
            d_color = GREEN
            ratio_label = "faster"
        else:
            d_color = ""
            ratio_label = ""

        # Column 1: stat name (left-justified)
        col_name = _color(f"{name}:", CYAN)

        # Column 2: baseline value (right-justified, colored)
        col_baseline = format_value_colored(baseline_ms)

        # Column 3: candidate value (right-justified, colored)
        col_candidate = format_value_colored(candidate_ms)

        # Column 4: delta (right-justified, colored)
        if delta == 0:
            col_delta = _color("—", DIM)
        else:
            sign = "+" if delta >= 0 else "-"
            d_num, d_unit, _ = _format_scaled(abs(delta))
            col_delta = f"{d_color}{sign}{d_num} {d_unit}{RESET}"

        # Column 5: ratio (right-justified, bold colored)
        if delta == 0:
            col_ratio = ""
        elif baseline_ms > 0 and candidate_ms > 0:
            ratio = max(baseline_ms, candidate_ms) / min(baseline_ms, candidate_ms)
            col_ratio = f"{BOLD}{d_color}{ratio:.2f}x {ratio_label}{RESET}"
        elif baseline_ms == 0 and candidate_ms > 0:
            col_ratio = f"{BOLD}{YELLOW}NEW{RESET}"
        elif candidate_ms == 0 and baseline_ms > 0:
            col_ratio = f"{BOLD}{DIM}REMOVED{RESET}"
        else:
            col_ratio = ""

        rows.append([col_name, col_baseline, col_candidate, col_delta, col_ratio])

    formatted = format_table(
        rows,
        justify_left={0},
        justify_right={1, 2, 3, 4},
        margin_right={0: 5, 1: 5, 2: 5, 3: 5},
    )

    # Prefix each line with "│ "
    lines = formatted.split("\n")
    return "\n".join(f"{GRAY}│{RESET} {line}" for line in lines)


# ── DiffNode + Tree ──


@dataclass
class DiffNode:
    """A node in the diff comparison tree."""
    name: str
    baseline_ms: float = 0
    candidate_ms: float = 0
    children: list[DiffNode] = field(default_factory=list)
    is_stat: bool = False


def _add_node(parent: Tree, node: DiffNode, min_ms: float) -> None:
    """Add a DiffNode to a rich Tree."""
    if node.baseline_ms < min_ms and node.candidate_ms < min_ms:
        return

    stat_children = [c for c in node.children if c.is_stat]
    tree_children = [c for c in node.children if not c.is_stat]

    # Build multi-line label: name + table-aligned stat rows
    label = Text.from_ansi(f"{BOLD}{WHITE}{node.name}{RESET}")

    if stat_children:
        stat_tuples = [(s.name, s.baseline_ms, s.candidate_ms) for s in stat_children]
        stat_text = build_stat_rows(stat_tuples)
        label.append_text(Text.from_ansi(f"\n{stat_text}"))

    branch = parent.add(label)

    for child in tree_children:
        _add_node(branch, child, min_ms)


def print_diff_tree(
    nodes: list[DiffNode],
    title: str = "",
    min_ms: float = 0,
    output_path: "Path | None" = None,
) -> None:
    """Print a diff comparison tree to stderr, or to a file if output_path is set."""
    tree = Tree("", hide_root=True, guide_style="dim")
    for node in nodes:
        _add_node(tree, node, min_ms)

    if output_path:
        from pathlib import Path as _Path
        output_path = _Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        file_console = Console(file=open(output_path, "w"), width=300)
        if title:
            file_console.print(f"\n[bold]{title}[/bold]")
        file_console.print(tree)
        click.echo(f"Output → {output_path}", err=True)
    else:
        if title:
            console.print(f"\n[bold]{title}[/bold]")
        console.print(tree)
