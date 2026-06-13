// glyphcast headless caster (Bun): a 24/7 station with no browser. ffmpeg
// decodes the source on loop at realtime pace -> encodeCells -> pack -> WS to
// the relay. The relay's "key" message resets wire state so late joiners get a
// keyframe. Reconnects forever; backpressure-gates like cast.html (skip frame
// when the socket buffer is deep). Env: GC_WS, GC_CH, GC_KEY (caster auth),
// GC_SRC, GC_COLS, GC_MODE, GC_FPS, GC_WIRE.
// Run: GC_CH=bbb bun server/caster.ts
// NOT responsible for: relaying (relay.ts), receiving (view.ts/term.ts).
// Test strategy: run against a local relay, GC_FRAMES=N term client converges
// on the same checksum as a paused second receiver.

import { encodeCells, sampleX, sampleY, type Mode } from '../src/encode'
import { createWireState, pack, type WireMode } from '../src/wire'

const WS_URL = process.env.GC_WS ?? 'ws://localhost:8788'
const CH = process.env.GC_CH ?? 'main'
const KEY = process.env.GC_KEY ?? ''
const SRC = process.env.GC_SRC ?? 'public/bbb60.mp4'
const COLS = Number(process.env.GC_COLS ?? 160)
const MODE = (process.env.GC_MODE ?? 'quadrant') as Mode
const FPS = Number(process.env.GC_FPS ?? 24)
const WIRE = (process.env.GC_WIRE ?? 'color') as WireMode

const CHAR_RATIO = 0.6
const ASPECT = 9 / 16
const ROWS = Math.max(1, Math.round(COLS * CHAR_RATIO * ASPECT))
const W = COLS * sampleX(MODE)
const H = ROWS * sampleY(MODE)
const FRAME_BYTES = W * H * 4

let ws: WebSocket | null = null
let state = createWireState(COLS, ROWS)
const fg = new Uint8Array(COLS * ROWS * 4)
const bg = new Uint8Array(COLS * ROWS * 4)
let sent = 0
let skipped = 0

function connect() {
  const url = `${WS_URL}/?role=cast&ch=${encodeURIComponent(CH)}${KEY ? `&key=${encodeURIComponent(KEY)}` : ''}`
  const sock = new WebSocket(url)
  sock.binaryType = 'arraybuffer'
  sock.onopen = () => {
    ws = sock
    state = createWireState(COLS, ROWS) // fresh state -> first pack is a keyframe
    console.log(`casting ${CH} @ ${COLS}x${ROWS} ${MODE}/${WIRE} ${FPS}fps -> ${WS_URL}`)
  }
  sock.onmessage = (e) => {
    if (e.data === 'key') state = createWireState(COLS, ROWS)
  }
  sock.onclose = () => {
    if (ws === sock) ws = null
    setTimeout(connect, 3000)
  }
  sock.onerror = () => {}
}
connect()

function castFrame(rgba: Uint8ClampedArray) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (ws.bufferedAmount > 8 * 1024 * 1024) {
    skipped++
    return
  }
  const img = { data: rgba, width: W, height: H, colorSpace: 'srgb' } as ImageData
  encodeCells(img, COLS, ROWS, MODE, 0, fg, bg)
  const pkt = pack(state, fg, bg, WIRE, MODE === 'octant')
  ws.send(pkt.slice())
  if (++sent % (FPS * 60) === 0) console.log(`${sent} frames sent, ${skipped} skipped`)
}

async function streamForever() {
  for (;;) {
    const proc = Bun.spawn(
      ['ffmpeg', '-v', 'error', '-re', '-stream_loop', '-1', '-i', SRC,
        '-vf', `scale=${W}:${H},fps=${FPS}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { stdout: 'pipe', stderr: 'inherit' },
    )
    let buf = new Uint8Array(0)
    const reader = proc.stdout.getReader()
    for (;;) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      const merged = new Uint8Array(buf.length + chunk.length)
      merged.set(buf)
      merged.set(chunk, buf.length)
      buf = merged
      while (buf.length >= FRAME_BYTES) {
        castFrame(new Uint8ClampedArray(buf.buffer, buf.byteOffset, FRAME_BYTES))
        buf = buf.slice(FRAME_BYTES)
      }
    }
    console.log('ffmpeg ended (exit ' + (await proc.exited) + ') - restarting in 2s')
    await new Promise((r) => setTimeout(r, 2000))
  }
}

void streamForever()
