// glyphcast terminal viewer (Bun): the dumb-receiver proof. No browser, no
// GPU, no pixels - a WS connection, the wire unpack, and ANSI truecolor
// escapes. Run: bun clients/term.ts [ws://host:8788]
// Env: GC_FRAMES=N exits after N frames and prints {frames, checksum} JSON
// to stderr - the E2E hook for checksum convergence against the caster.
// Test strategy: GC_FRAMES=1 against a paused caster (keyframe-only) and
// compare checksums.

import { GLYPH_CHARS } from '../src/encode'
import { createWireState, stateChecksum, unpack, type WireMode, type WireState } from '../src/wire'

const wsUrl = process.argv[2] ?? 'ws://localhost:8788'
const maxFrames = Number(process.env.GC_FRAMES ?? 0)

let state: WireState | null = null
let mode: WireMode = 'color'
let frames = 0

const up = (v: number, hi: number, lo: number) => {
  const x = (v >> lo) & ((1 << (hi - lo)) - 1)
  const bits = hi - lo
  return (x << (8 - bits)) | (x >> (2 * bits - 8))
}

function render(s: WireState) {
  const tty = process.stdout.isTTY
  const cols = tty ? Math.min(s.cols, process.stdout.columns || s.cols) : s.cols
  const rows = tty ? Math.min(s.rows, (process.stdout.rows || s.rows + 2) - 2) : s.rows
  let out = '\x1b[H'
  for (let y = 0; y < rows; y++) {
    let lastFg = -1
    let lastBg = -1
    for (let x = 0; x < cols; x++) {
      const i = y * s.cols + x
      const g = s.glyph[i]
      if (g === 255) {
        out += ' '
        continue
      }
      if (mode === 'color') {
        const f = s.fg[i]
        const b = s.bg[i]
        if (f !== lastFg) {
          out += `\x1b[38;2;${up(f, 16, 11)};${up(f, 11, 5)};${up(f, 5, 0)}m`
          lastFg = f
        }
        if (b !== lastBg) {
          out += `\x1b[48;2;${up(b, 16, 11)};${up(b, 11, 5)};${up(b, 5, 0)}m`
          lastBg = b
        }
      }
      out += GLYPH_CHARS[g] ?? ' '
    }
    out += '\x1b[0m\n'
  }
  process.stdout.write(out)
}

const ws = new WebSocket(`${wsUrl}/?role=view`)
ws.binaryType = 'arraybuffer'

ws.onmessage = (e) => {
  if (typeof e.data === 'string') return
  const pkt = new Uint8Array(e.data as ArrayBuffer)
  mode = pkt[0] === 1 ? 'color' : 'mono'
  const cols = pkt[1] | (pkt[2] << 8)
  const rows = pkt[3] | (pkt[4] << 8)
  if (!state || state.cols !== cols || state.rows !== rows) {
    state = createWireState(cols, rows)
    process.stdout.write('\x1b[2J')
  }
  unpack(pkt, state)
  render(state)
  frames++
  if (maxFrames && frames >= maxFrames) {
    process.stderr.write(JSON.stringify({ frames, checksum: stateChecksum(state, mode), cols, rows, mode }) + '\n')
    ws.close()
    process.exit(0)
  }
}

ws.onerror = () => {
  process.stderr.write(`cannot reach relay at ${wsUrl}\n`)
  process.exit(1)
}

console.log(`glyphcast term viewer -> ${wsUrl} (waiting for caster)`)
