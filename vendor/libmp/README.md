# LibMP 1.1

Roblox's LibMP JavaScript build, its viewer, and its tools, byte-for-byte from
Roblox's asset host. rbx-microprofiler reads `.gprx` and `.x.html` captures
with them.

| File | Source | sha256 |
|------|--------|--------|
| `libmp.js` | https://assets.create.roblox.com/assets/scripts/libmp/10072026/1.1/libmp.js | `d2a045a3d0fbfafe400aad6ef5fe7a0068e90bf8eec9acb7af9aa2ee198b45e3` |
| `tools.js` | https://assets.create.roblox.com/assets/scripts/libmp/10072026/1.1/tools.js | `74d4ac9b07369b2e8435cfea506181971b879d8e84e7c8427a8eb43da2d288c2` |
| `viewer.js` | https://assets.create.roblox.com/assets/scripts/libmp/10072026/1.1/viewer.js | `955fd1b868402479569f12fba5a8c700776b18e22236b0e972fa3aeabb11a2c0` |

The `.d.ts` files beside them are rbx-microprofiler's: they type the files as the text
src/lib/libmp.ts imports them as.

LibMP is MIT-licensed (https://github.com/Roblox/libmp/blob/HEAD/LICENSE).
`libmp.js` bundles FlatBuffers (Apache 2.0) and LZ4 (BSD 2-Clause); their
licenses are linked from its header.
