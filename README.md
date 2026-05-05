# rbx-microprofiler

CLI for Roblox MicroProfiler dump analysis. Parse `.raw` and `.html` dumps, generate flamegraphs, and compare performance across builds.

## Install

### mise

```toml
[tools]
"ubi:revvy02/rbx-microprofiler" = "0.1.0"
```

### Rokit

```sh
rokit add revvy02/rbx-microprofiler
```

## Canonical MicroProfiler Usage

### convert

Convert between the two MicroProfiler dump formats: `.raw` (binary) and `.html` (self-contained viewer).

```sh
# raw -> html (adds the interactive viewer)
rbx-microprofiler convert dump.raw dump.html

# html -> raw (extracts the binary data)
rbx-microprofiler convert dump.html dump.raw
```

### summary

Print a JSON summary of one or more dumps with frame timing statistics, top functions by CPU/GPU time, and platform info.

```sh
# Single dump
rbx-microprofiler summary dump.raw

# Multiple dumps (aggregated with weighted averaging)
rbx-microprofiler summary dumps/

# Output includes:
# - num_frames, cpu/gpu time (mean, median, max, stddev)
# - top functions by total and max time
# - platform_info, general_info
```

### flamegraph

Generate an interactive flamegraph HTML from one or more dumps.

```sh
# Single dump
rbx-microprofiler flamegraph dump.raw -o flamegraph.html --open

# Multiple dumps merged into one flamegraph
rbx-microprofiler flamegraph dumps/ -o flamegraph.html

# --open flag opens the result in your default browser
```

### diff-flamegraph

Generate a differential flamegraph comparing baseline vs candidate dumps. Red = regression, blue = improvement.

```sh
rbx-microprofiler diff-flamegraph \
  -b baseline/ \
  -c candidate/ \
  -o diff.html --open
```

## Advanced

### File Formats

| Format | Extension | Description |
|--------|-----------|-------------|
| Raw | `.raw` | Binary R0FL format (4 zero bytes + `R0FL` magic + payload) |
| HTML | `.html` | Self-contained viewer with embedded compressed data |

### diff

Compare baseline vs candidate with per-node statistics in a tree view.

```sh
rbx-microprofiler diff \
  -b baseline/ \
  -c candidate/ \
  --min-ms 0.1 \
  --depth 5
```

