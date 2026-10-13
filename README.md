# rbx-microprofiler

CLI for Roblox MicroProfiler dump analysis. Read legacy `.raw` and `.html` dumps and LibMP `.gprx` and `.x.html` captures, generate flamegraphs, and compare performance across builds.

## Install

### mise

```toml
[tools]
"ubi:revvy02/rbx-microprofiler" = "0.4.0"
```

### Rokit

```sh
rokit add revvy02/rbx-microprofiler
```

## Canonical MicroProfiler Usage

### convert

Convert a dump between the formats of its family: legacy `.raw` and `.html`, or LibMP `.gprx` and `.x.html`. Legacy dumps and LibMP captures don't convert into each other.

```sh
# raw -> html (adds the interactive viewer)
rbx-microprofiler convert dump.raw dump.html

# html -> raw (extracts the binary data)
rbx-microprofiler convert dump.html dump.raw

# gprx -> x.html (opens in Roblox's LibMP viewer)
rbx-microprofiler convert capture.gprx capture.x.html

# x.html -> gprx (compressed)
rbx-microprofiler convert capture.x.html capture.gprx
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

Generate an interactive flamegraph HTML from one or more dumps, in any mix of formats. Several dumps merge into one flamegraph of per-frame averages, read one dump at a time, so memory and the page's size don't grow with the number of dumps.

```sh
# Single dump
rbx-microprofiler flamegraph dump.raw -o flamegraph.html --open

# Multiple dumps merged into one flamegraph
rbx-microprofiler flamegraph dumps/ -o flamegraph.html

# --open flag opens the result in your default browser
```

### diff-flamegraph

Generate a differential flamegraph comparing baseline vs candidate dumps. Each node takes the color of the side that spends more time in it: green for the baseline, blue for the candidate.

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
| Raw | `.raw` | Legacy binary R0FL format (4 zero bytes + `R0FL` magic + payload) |
| HTML | `.html` | Legacy self-contained viewer with embedded compressed data |
| GPRX | `.gprx` | LibMP capture (MicroProfiler **Dump** ➔ **Dump in binary format**) |
| LibMP HTML | `.x.html` | LibMP capture embedded in a page that loads Roblox's LibMP viewer |

Studio's auto-captures (`AutoCapture_*.raw`) are legacy dumps.

### diff

Compare baseline vs candidate with per-node statistics in a tree view. Each node's values are its per-frame averages across each side's dumps, as the diff flamegraph shows them.

```sh
rbx-microprofiler diff \
  -b baseline/ \
  -c candidate/ \
  --min-ms 0.1 \
  --depth 5
```

