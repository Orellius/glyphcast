// glyphTV viewer: pure receiver and the TV itself. No <video>, no sampling -
// just WS packets unpacked into receiver state, expanded to RGBA cell
// buffers, one GL draw per packet. Grid dims come from the packet header.
// Fullscreen black shell, stats fade when idle, click = fullscreen toggle.
// URL knobs: ?ws=ws://host:8788&ch=main&scan=0.25&gap=0.15&glow=0.3
// NOT responsible for: encoding or capture - a viewer never sees pixels.
// Test strategy: E2E checksum convergence with cast.ts via window.__gcv.

import { measureCharRatio } from './grid'
import { createRendererGL } from './renderer_gl'
import { createWireState, stateChecksum, stateToCells, unpack, type WireMode, type WireState } from './wire'

const q = new URLSearchParams(location.search)
const wsUrl = q.get('ws') ?? 'ws://localhost:8788'
const ch = q.get('ch') ?? 'main'
// scan/gap draw the panel's line structure - they read as black lines at
// lower cols, so they are opt-in; glow only adds light, safe as default
const fx = {
  scan: Number(q.get('scan') ?? 0),
  gap: Number(q.get('gap') ?? 0),
  glow: Number(q.get('glow') ?? 0.3),
}

const canvas = document.getElementById('glcanvas') as HTMLCanvasElement
const statsEl = document.getElementById('stats') as HTMLSpanElement

const CHAR_RATIO = measureCharRatio()
const gl = createRendererGL(canvas)
gl.setFx(fx.scan, fx.gap, fx.glow)

// TV shell: stats fade after idle, click toggles fullscreen
let idleT = 0
function poke() {
  document.body.classList.remove('idle')
  clearTimeout(idleT)
  idleT = window.setTimeout(() => document.body.classList.add('idle'), 2500)
}
window.addEventListener('mousemove', poke)
poke()
canvas.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void document.documentElement.requestFullscreen()
})
window.addEventListener('resize', () => {
  if (state) layout(state.cols, state.rows)
})

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
  // fit the cell grid inside the viewport preserving aspect
  const fs = Math.min(wrap.clientWidth / (cols * CHAR_RATIO), wrap.clientHeight / rows)
  gl.resize(cols * CHAR_RATIO * fs, rows * fs)
}

const ws = new WebSocket(`${wsUrl}/?role=view&ch=${encodeURIComponent(ch)}`)
ws.binaryType = 'arraybuffer'
ws.addEventListener('message', (e) => {
  if (typeof e.data === 'string') return
  const pkt = new Uint8Array(e.data as ArrayBuffer)
  wireMode = pkt[0] & 1 ? 'color' : 'mono'
  const octantPage = (pkt[0] & 2) !== 0
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
  gl.render(fg, bg, cols, rows, octantPage)

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
      `glyphTV · ch ${ch} · ${cols}×${rows} ${wireMode} · ${stats.fps.toFixed(0)} fps · ` +
      `${stats.kbps} kbps raw · ${stats.frames} frames`
  }
})
ws.addEventListener('close', () => {
  statsEl.textContent = `glyphTV · ch ${ch} · signal lost`
  document.body.classList.remove('idle')
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
