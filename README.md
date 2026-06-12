<p align="center"><img src="public/brand/glyphcast-mark.svg" width="88" alt="glyphcast" /></p>

# glyphcast

Video as text. A typography-only video codec + streaming stack: every frame is a
grid of monospace glyphs (Unicode octant / sextant / quadrant blocks / halfblocks /
ascii ramp) with per-cell colors. Renders in a browser at video fps, streams over
WebSocket in a byte-aligned wire format dumb enough for a terminal - or an MCU -
to decode. glyphTV on top: fullscreen stations you tune into like television.

Live: [glyphcast.tv](https://glyphcast.tv)

## Proof lab

Every claim below was measured live (M4 Max, Chrome-family browser, Big Buck
Bunny 1080p60), not estimated. Reproduce with the listed setup.

| Proof | Setup | Measured |
|---|---|---|
| Text renders at video fps | `lab.html`, gpu engine, quadrant 640 cols | 138,880 cells @ 60+ fps, 0ms CPU, 1 draw call |
| 4K-class panel from typography | gpu direct, octant 1920 cols | 1,248,000 cells = 3840×2600 subpixel lattice @ 67 fps, glErr 0 |
| Wire format is lossless | `__gc.benchWire` roundtrip, all modes | pack→unpack states identical (checksum), every config |
| Ultra-low bandwidth tier | 160 cols quadrant @ 24fps, deflated | color ≈ 1.8 Mbps · mono ≈ 266 kbps |
| Octant fidelity is cheap | 160 cols octant vs quadrant @ 24fps | 1979 vs 1744 kbps deflated: 2× vertical detail for +13% |
| Live streaming is lossless | cast → relay → view, 666 frames @ 30fps | sender/receiver checksums identical, incl. mid-stream late join |
| A terminal is a full receiver | `bun clients/term.ts` vs paused caster | checksum identical; 4,337 real U+1CD00 octant glyphs in one frame |
| Channels isolate | viewer on channel B vs caster on A | 0 packets received; same-channel viewer streams fine |
| Million-cell broadcast | 8-worker caster, octant 1920 cols | 1,248,000 cells streamed @ 32 fps (single-thread: 17) |
| Background casting survives | hidden tab caster | ~30 fps via worker timer + auto-resume vs Chrome's bg pause |
| Single-thread encoder ceiling | `__gc.benchCells`, octant | 640 cols: 54 fps · 960: 29 · 1280: 17 (hence the worker pool) |

## Pieces

- `index.html` - the landing page. Its hero IS the codec: the demo video rendered
  live as glyph cells by the gpu direct engine (`src/landing.ts`), with a
  copy-frame-as-text proof button.
- `lab.html` - the player/lab. Two engines: **gpu** (WebGL2, the cell encode runs
  in the fragment shader, zero CPU per frame, one draw call) and **dom** (CPU encode
  to runs of `<span>`, dirty-row innerHTML - the "it really is text" proof). Modes:
  octant (2×4 subpixels/char, sharpest), sextant (2×3), quadrant (2×2), halfblock,
  ascii. Sliders for cols (80-1920), quantization, unsharp, glow.
- `src/wire.ts` - wire format v1: cell = glyph index (+ fg/bg RGB565 in color mode),
  frame = skip/emit runs vs previous frame. Byte-aligned, no entropy coding;
  transport deflate does that layer (relay: `GC_DEFLATE=1`). Octants ride a glyph
  page flag (header bit 1). `src/octants.ts` is generated from UnicodeData.txt.
- `server/relay.ts` - Bun WS relay with named channels (stations): one caster in,
  N viewers out per channel, keyframe request on join. `bun run relay` (port 8788).
- `cast.html` - the station. Encodes a playing video to wire deltas via a band-
  parallel worker pool (`src/encode.worker.ts`, cores-2 workers, ImageBitmap +
  OffscreenCanvas per band). Survives hidden tabs. Knobs:
  `?cols=1920&mode=octant&wire=color|mono&ch=main&src=/bbb60.mp4`.
- `view.html` - **glyphTV**. Pure receiver: no `<video>` element, no pixels in, so
  no autoplay policy applies anywhere - the set turns on instantly, Brave included.
  Fullscreen black shell, idle-fading stats, click = fullscreen. Knobs:
  `?ch=main&scan=&gap=&glow=&oled=1&oledgain=2.6` - display FX are opt-in;
  `oled=1` renders every glyph subpixel as an RGB emitter triad with black matrix
  (the microscope-photo look; gain compensates the matrix area).
- `clients/term.ts` - terminal receiver: `GC_CH=main bun clients/term.ts` renders
  the same stream with ANSI truecolor escapes. The IoT claim, proven.

## Run

```sh
bun install
bun run dev      # vite: landing + lab/player/cast/view pages
bun run relay    # WS relay on :8788
# station:  /cast.html?cols=960&mode=octant&ch=bbb
# TV:       /view.html?ch=bbb            (+ &oled=1 for the emitter look)
GC_CH=bbb bun clients/term.ts            # same broadcast, in a terminal
```

## Bandwidth tiers (honest)

The two superpowers trade off. Ultra-low bandwidth lives at low cols; ultra
fidelity lives at high cols and wants a LAN:

- **IoT / internet**: 160-320 cols - hundreds of kbps (mono) to a few Mbps (color).
- **Desktop / LAN**: 640-960 cols - tens of Mbps.
- **glyphTV 4K rung**: 1920 cols - ~520 Mbps raw. LAN/Tailscale tier.

Text-cell video is not "kilobytes" - those claims died with ASCILINE. H.264/AV1
win photographic fidelity-per-bit by orders of magnitude, forever. This is a
different medium: video whose reconstruction alphabet is printable characters,
decodable by anything that can print - browser, terminal, character LCD.

## Brand

The mark is a play triangle rasterized into quadrant glyph cells - the same cell
grammar the codec uses. It exists as SVG and as plain Unicode, with identical masks:

```
▙▄
███▄
███▀
▛▀
```

Assets live in `public/brand/` and are generated by `scripts/gen-brand.ts` -
regenerate, never hand-edit. Guidelines + downloads: [glyphcast.tv/brand](https://glyphcast.tv/brand/index.html).
Colors: phosphor green `#3ddc84` on screen black `#0a0a0c`.
