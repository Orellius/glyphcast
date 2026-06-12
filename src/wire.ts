// glyphcast wire format v1: a video frame as a stream of typography cells,
// built for ultra-low bandwidth and dumb receivers (terminals, MCUs).
// Cell = glyph index + (color mode) fg/bg RGB565. Frames are skip/emit run
// pairs vs the previous frame: [u16 skip][u16 emit][emit * payload] repeated.
// Byte-aligned, no entropy coding - an ESP32 or a shell script can decode it;
// transport-level deflate (WS permessage-deflate) is measured separately.
// NOT responsible for: pixel->cell encoding (encode.ts), transport, rendering.
// Test strategy: pack/unpack roundtrip equality + live bitrate bench via __gc.

export type WireMode = 'color' | 'mono'

// receiver-side cell state; pack() also consumes it as the prev-frame reference
export type WireState = {
  cols: number
  rows: number
  glyph: Uint8Array
  fg: Uint16Array
  bg: Uint16Array
}

export function createWireState(cols: number, rows: number): WireState {
  const n = cols * rows
  return { cols, rows, glyph: new Uint8Array(n).fill(255), fg: new Uint16Array(n), bg: new Uint16Array(n) }
}

const to565 = (buf: Uint8Array, i: number) =>
  ((buf[i] >> 3) << 11) | ((buf[i + 1] >> 2) << 5) | (buf[i + 2] >> 3)

const HDR = 5
const payloadBytes = (mode: WireMode) => (mode === 'color' ? 5 : 1)

// fg/bg are encodeCells output (RGBA, glyph idx in fg alpha). Updates state in
// place to the new frame and returns the packed delta (keyframe when state is
// fresh: every cell differs from the 255 sentinel).
export function pack(state: WireState, fg: Uint8Array, bg: Uint8Array, mode: WireMode): Uint8Array {
  const n = state.cols * state.rows
  const pb = payloadBytes(mode)
  const out = new Uint8Array(HDR + n * (pb + 4) + 8)
  out[0] = mode === 'color' ? 1 : 0
  out[1] = state.cols & 255
  out[2] = state.cols >> 8
  out[3] = state.rows & 255
  out[4] = state.rows >> 8
  let w = HDR
  let i = 0
  while (i < n) {
    let skip = 0
    while (i < n && !cellChanged(state, fg, bg, i, mode)) {
      skip++
      i++
    }
    if (i >= n && skip > 0) break
    if (i >= n) break
    let emitStart = i
    while (i < n && cellChanged(state, fg, bg, i, mode) && i - emitStart < 65535) i++
    const emit = i - emitStart
    while (skip > 65535) {
      out[w++] = 255; out[w++] = 255; out[w++] = 0; out[w++] = 0
      skip -= 65535
    }
    out[w++] = skip & 255
    out[w++] = skip >> 8
    out[w++] = emit & 255
    out[w++] = emit >> 8
    for (let c = emitStart; c < i; c++) {
      const g = fg[c * 4 + 3]
      state.glyph[c] = g
      out[w++] = g
      if (mode === 'color') {
        const f5 = to565(fg, c * 4)
        const b5 = to565(bg, c * 4)
        state.fg[c] = f5
        state.bg[c] = b5
        out[w++] = f5 & 255
        out[w++] = f5 >> 8
        out[w++] = b5 & 255
        out[w++] = b5 >> 8
      }
    }
  }
  return out.subarray(0, w)
}

function cellChanged(state: WireState, fg: Uint8Array, bg: Uint8Array, i: number, mode: WireMode): boolean {
  if (state.glyph[i] !== fg[i * 4 + 3]) return true
  if (mode === 'mono') return false
  return state.fg[i] !== to565(fg, i * 4) || state.bg[i] !== to565(bg, i * 4)
}

// applies a packed frame onto receiver state; returns cells touched
export function unpack(buf: Uint8Array, state: WireState): number {
  const mode: WireMode = buf[0] === 1 ? 'color' : 'mono'
  const cols = buf[1] | (buf[2] << 8)
  const rows = buf[3] | (buf[4] << 8)
  if (cols !== state.cols || rows !== state.rows) throw new Error(`grid mismatch: ${cols}x${rows} vs state ${state.cols}x${state.rows}`)
  let r = HDR
  let i = 0
  let touched = 0
  while (r < buf.length) {
    const skip = buf[r] | (buf[r + 1] << 8)
    const emit = buf[r + 2] | (buf[r + 3] << 8)
    r += 4
    i += skip
    for (let e = 0; e < emit; e++, i++) {
      state.glyph[i] = buf[r++]
      if (mode === 'color') {
        state.fg[i] = buf[r] | (buf[r + 1] << 8)
        state.bg[i] = buf[r + 2] | (buf[r + 3] << 8)
        r += 4
      }
    }
    touched += emit
  }
  return touched
}

export function statesEqual(a: WireState, b: WireState, mode: WireMode): boolean {
  for (let i = 0; i < a.glyph.length; i++) {
    if (a.glyph[i] !== b.glyph[i]) return false
    if (mode === 'color' && (a.fg[i] !== b.fg[i] || a.bg[i] !== b.bg[i])) return false
  }
  return true
}

// total deflated size of a frame sequence with shared context - honest stand-in
// for WS permessage-deflate with context takeover
export async function deflatedSize(frames: Uint8Array[]): Promise<number> {
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  const done = new Response(cs.readable).arrayBuffer()
  for (const f of frames) await writer.write(f)
  await writer.close()
  return (await done).byteLength
}
