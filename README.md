# glyphcast

Video as text. A typography-only video codec + streaming stack: every frame is a
grid of monospace glyphs (Unicode sextant / quadrant blocks / halfblocks / ascii
ramp) with per-cell colors. Renders in a browser at video fps, streams over WebSocket in a
byte-aligned wire format dumb enough for a terminal - or an MCU - to decode.

## Pieces

- `index.html` - the player/lab. Two engines: **gpu** (WebGL2, the cell encode runs
  in the fragment shader, zero CPU per frame, one draw call) and **dom** (CPU encode
  to runs of `<span>`, dirty-row innerHTML). Modes: sextant (2x3 subpixels/char,
  the sharpest), quadrant (2x2), halfblock, ascii. Sliders for cols (80-640),
  quantization, unsharp, glow.
- `src/wire.ts` - wire format v1: cell = glyph index (+ fg/bg RGB565 in color mode),
  frame = skip/emit runs vs previous frame. Byte-aligned, no entropy coding;
  transport deflate (WS permessage-deflate) does that layer.
- `server/relay.ts` - Bun WS relay: one caster in, N viewers out, keyframe request
  on join. `bun run relay` (port 8788).
- `cast.html` - encodes a playing video to wire deltas, ships to the relay.
  Survives hidden tabs (worker-timer drive + auto-resume against Chrome's
  background video pause). Knobs: `?cols=240&wire=color|mono&src=/bbb60.mp4`.
- `view.html` - pure receiver: no video element, no pixels. Unpacks packets into
  cell state, one GL draw per packet.
- `clients/term.ts` - terminal receiver: `bun clients/term.ts` renders the same
  stream with ANSI truecolor escapes. The wire format's IoT claim, proven.

## Run

```sh
bun install
bun run dev      # vite, the player + cast/view pages
bun run relay    # WS relay on :8788
# open /cast.html?cols=240 and /view.html in two tabs
bun clients/term.ts   # third receiver, in a terminal
```

## Honest numbers (M4 Max, Chrome, Big Buck Bunny 1080p60)

- GPU engine: video-fps rendering at 640x217 cells (138k cells), 0ms CPU/frame.
- Wire format @ 24fps quadrant color, measured by `__gc.benchWire`, deflate =
  permessage-deflate stand-in, roundtrip lossless on all configs:
  - 160 cols (8.6k cells): ~1.8 Mbps deflated; mono: ~266 kbps
  - 320 cols (34.6k cells): ~6.6 Mbps deflated
- Live stream E2E (240 cols color @30fps): sender/receiver state checksums
  identical after 666 frames, after a mid-stream late join, and on the terminal
  client. ~10 Mbps raw pre-deflate.

Text-cell video is not "kilobytes" - those claims died with ASCILINE. It is a
legible-bandwidth, GPU-cheap, terminal-decodable way to move moving pictures
as pure typography.
