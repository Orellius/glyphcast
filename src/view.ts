// glyphcast viewer: pure receiver. No <video>, no sampling - just WS packets
// unpacked into receiver state, expanded to RGBA cell buffers, one GL draw
// per packet. Grid dims come from the packet header; first packet allocates.
// URL knobs: ?ws=ws://host:8788
// NOT responsible for: encoding or capture - a viewer never sees pixels.
// Test strategy: E2E checksum convergence with cast.ts via window.__gcv.

import { measureCharRatio } from './grid'
import { createRendererGL } from './renderer_gl'
import { createWireState, stateChecksum, stateToCells, unpack, type WireMode, type WireState } from './wire'

const q = new URLSearchParams(location.search)
const wsUrl = q.get('ws') ?? 'ws://localhost:8788'

const canvas = document.getElementById('glcanvas') as HTMLCanvasElement
const statsEl = document.getElementById('stats') as HTMLSpanElement

const CHAR_RATIO = measureCharRatio()
const gl = createRendererGL(canvas)

let state: WireState | null = null
let wireMode: WireMode = 'color'
let fg = new Uint8Array(0)
let bg = new Uint8Array(0)

const stats = { frames: 0, recvBytes: 0, kbps: 0, fps: 0, cells: 0 }
let lastAt = 0
let winBytes = 0
let winAt = performance.now()

function layout(cols: number, rows: number) {
  const wrap = document.getElementById('wrap') as HTMLDivElement
  const fs = wrap.clientWidth / (cols * CHAR_RATIO)
  gl.resize(wrap.clientWidth, rows * fs)
}

const ws = new WebSocket(`${wsUrl}/?role=view`)
ws.binaryType = 'arraybuffer'
ws.addEventListener('message', (e) => {
  if (typeof e.data === 'string') return
  const pkt = new Uint8Array(e.data as ArrayBuffer)
  wireMode = pkt[0] === 1 ? 'color' : 'mono'
  const cols = pkt[1] | (pkt[2] << 8)
  const rows = pkt[3] | (pkt[4] << 8)
  if (!state || state.cols !== cols || state.rows !== rows) {
    state = createWireState(cols, rows)
    const n = cols * rows * 4
    fg = new Uint8Array(n)
    bg = new Uint8Array(n)
    stats.cells = cols * rows
    layout(cols, rows)
  }
  unpack(pkt, state)
  stateToCells(state, wireMode, fg, bg)
  gl.render(fg, bg, cols, rows)

  const now = performance.now()
  stats.frames++
  stats.recvBytes += pkt.length
  winBytes += pkt.length
  if (lastAt) stats.fps = stats.fps * 0.9 + (1000 / (now - lastAt)) * 0.1
  lastAt = now
  if (now - winAt > 500) {
    stats.kbps = Math.round((winBytes * 8) / (now - winAt))
    winBytes = 0
    winAt = now
    statsEl.textContent =
      `view · ${cols}×${rows} ${wireMode} · ${stats.fps.toFixed(0)} fps · ` +
      `${stats.kbps} kbps raw · ${stats.frames} frames`
  }
})
ws.addEventListener('close', () => {
  statsEl.textContent = 'view · ws closed'
})

declare global {
  interface Window {
    __gcv: {
      stats: typeof stats
      grid: () => { cols: number; rows: number; wireMode: WireMode } | null
      checksum: () => number
    }
  }
}
window.__gcv = {
  stats,
  grid: () => (state ? { cols: state.cols, rows: state.rows, wireMode } : null),
  checksum: () => (state ? stateChecksum(state, wireMode) : -1),
}
