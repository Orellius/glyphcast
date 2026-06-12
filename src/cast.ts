// glyphcast caster: plays a video, encodes each rVFC frame to wire cells,
// packs the delta vs sender state, ships it over WS to the relay. Renders its
// own cell buffers to a local GL preview so what you see IS what you sent.
// Relay's "key" control message resets sender state -> next pack is a keyframe.
// URL knobs: ?cols=240&wire=color|mono&ws=ws://host:8788&src=/bbb60.mp4
// NOT responsible for: relaying (server/relay.ts), viewing (view.ts).
// Test strategy: E2E checksum convergence with view.ts via window.__gcc.

import { encodeCells, sampleX, sampleY, type Mode } from './encode'
import { measureCharRatio, rowsFor } from './grid'
import { createRendererGL } from './renderer_gl'
import { createSampler } from './sampler'
import { createWireState, pack, stateChecksum, type WireDepth, type WireMode, type WireState } from './wire'

const q = new URLSearchParams(location.search)
const cols = Number(q.get('cols') ?? 240)
const wireMode: WireMode = q.get('wire') === 'mono' ? 'mono' : 'color'
const depth: WireDepth = q.get('depth') === '565' ? '565' : '888'
const p3 = q.get('p3') === '1'
const wsUrl = q.get('ws') ?? 'ws://localhost:8788'
const mq = q.get('mode')
const mode: Mode = mq === 'sextant' ? 'sextant' : mq === 'octant' ? 'octant' : 'quadrant'

const video = document.getElementById('video') as HTMLVideoElement
if (q.get('src') === 'gradient') {
  // banding lab source: a slow-drifting smooth gradient - the case that
  // exposes color quantization (skies, sunsets)
  const c = document.createElement('canvas')
  c.width = 1280
  c.height = 720
  const cx = c.getContext('2d')!
  let t = 0
  setInterval(() => {
    t += 0.25
    const g = cx.createLinearGradient(0, 0, 1280, 720)
    g.addColorStop(0, `hsl(${(210 + t) % 360} 55% 6%)`)
    g.addColorStop(1, `hsl(${(250 + t) % 360} 65% 52%)`)
    cx.fillStyle = g
    cx.fillRect(0, 0, 1280, 720)
  }, 33)
  video.srcObject = c.captureStream(30)
} else {
  video.src = q.get('src') ?? '/bbb60.mp4'
}
const canvas = document.getElementById('glcanvas') as HTMLCanvasElement
const statsEl = document.getElementById('stats') as HTMLSpanElement

const CHAR_RATIO = measureCharRatio()
const sampler = createSampler(p3)
const gl = createRendererGL(canvas, { p3 })

let rows = 0
let fg = new Uint8Array(0)
let bg = new Uint8Array(0)
let state: WireState | null = null
let wantKey = false

const stats = { frames: 0, sentBytes: 0, kbps: 0, fps: 0 }
let lastAt = 0
let winBytes = 0
let winAt = performance.now()

const ch = q.get('ch') ?? 'main'
const ws = new WebSocket(`${wsUrl}/?role=cast&ch=${encodeURIComponent(ch)}`)
ws.binaryType = 'arraybuffer'
ws.addEventListener('message', (e) => {
  if (e.data === 'key') wantKey = true
})

function layout() {
  rows = rowsFor(cols, CHAR_RATIO, video.videoWidth || 16, video.videoHeight || 9)
  const n = cols * rows * 4
  fg = new Uint8Array(n)
  bg = new Uint8Array(n)
  state = createWireState(cols, rows)
  const wrap = document.getElementById('wrap') as HTMLDivElement
  const fs = wrap.clientWidth / (cols * CHAR_RATIO)
  gl.resize(wrap.clientWidth, rows * fs)
  initPool()
}

// band-parallel encode pool: sampling + encodeCells are the two serial costs
// that cap the caster (~34ms/frame at 960 cols); both shard cleanly by rows
type BandMsg = { seq: number; y0: number; fg: Uint8Array; bg: Uint8Array }
const PARALLEL_MIN_CELLS = 120_000
let pool: Worker[] = []
let poolSeq = 0
let inFlight = false
let arrived = 0

function initPool() {
  for (const w of pool) w.terminate()
  pool = []
  inFlight = false
  if (typeof OffscreenCanvas === 'undefined' || cols * rows < PARALLEL_MIN_CELLS) return
  const n = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2))
  const base = Math.floor(rows / n)
  let y = 0
  for (let i = 0; i < n; i++) {
    const h = i < rows % n ? base + 1 : base
    const w = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' })
    w.postMessage({ kind: 'init', cols, rowsTotal: rows, y0: y, y1: y + h, mode, qShift: 0 })
    w.onmessage = (e: MessageEvent<BandMsg>) => onBand(e.data)
    pool.push(w)
    y += h
  }
}

function onBand(b: BandMsg) {
  if (b.seq !== poolSeq || !inFlight) return
  fg.set(b.fg, b.y0 * cols * 4)
  bg.set(b.bg, b.y0 * cols * 4)
  arrived++
  if (arrived < pool.length) return
  inFlight = false
  finishFrame(performance.now())
}

let lastT = -1

function castFrame(now: number) {
  if (video.readyState < 2 || !state) return
  if (video.currentTime === lastT && !wantKey) return
  if (pool.length) {
    if (inFlight) return
    lastT = video.currentTime
    inFlight = true
    arrived = 0
    poolSeq++
    const seq = poolSeq
    void createImageBitmap(video).then((bmp) => {
      // postMessage without transfer clones the bitmap per worker
      for (const w of pool) w.postMessage({ kind: 'frame', seq, bitmap: bmp })
      bmp.close()
    })
    return
  }
  lastT = video.currentTime
  const img = sampler.sample(video, cols * sampleX(mode), rows * sampleY(mode))
  encodeCells(img, cols, rows, mode, 0, fg, bg)
  finishFrame(now)
}

function finishFrame(now: number) {
  if (!state) return
  if (wantKey) {
    state.glyph.fill(255)
    wantKey = false
  }
  const pkt = pack(state, fg, bg, wireMode, mode === 'octant', depth)
  if (ws.readyState === WebSocket.OPEN) ws.send(pkt)
  if (!document.hidden) gl.render(fg, bg, cols, rows, mode === 'octant')
  stats.frames++
  stats.sentBytes += pkt.length
  winBytes += pkt.length
  if (lastAt) stats.fps = stats.fps * 0.9 + (1000 / (now - lastAt)) * 0.1
  lastAt = now
  if (now - winAt > 500) {
    stats.kbps = Math.round((winBytes * 8) / (now - winAt))
    winBytes = 0
    winAt = now
    statsEl.textContent =
      `cast · ${cols}×${rows} ${wireMode}${wireMode === 'color' ? ` rgb${depth}` : ''} · ${pool.length ? `${pool.length}-worker` : 'sync'} · ` +
      `${stats.fps.toFixed(0)} fps · ${stats.kbps} kbps raw · ${stats.frames} frames · ws ${ws.readyState === 1 ? 'up' : 'down'}`
  }
}

function onFrame(now: number) {
  if (!document.hidden) castFrame(now)
  video.requestVideoFrameCallback(onFrame)
}

// rVFC freezes in hidden tabs; a dedicated-worker timer doesn't. The video
// keeps decoding while playing, so casting survives backgrounding.
const tickWorker = new Worker(
  URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' })),
)
tickWorker.onmessage = () => {
  // hidden: worker replaces frozen rVFC. wantKey: a paused video produces no
  // rVFC ticks at all, so a pending keyframe must be pushed from here too.
  if (document.hidden || wantKey) castFrame(performance.now())
}

// Chrome's background optimization pauses muted video-only playback in hidden
// tabs; re-playing from the pause event keeps the cast alive. userPaused
// distinguishes a deliberate click-pause from the policy pause.
let userPaused = false
video.addEventListener('pause', () => {
  if (!userPaused) void video.play()
})

// in a tab that loads hidden, the autoplay attribute never fires - retry
// play() until decoding starts
const kick = setInterval(() => {
  if (userPaused) return
  if (!video.paused) clearInterval(kick)
  else if (video.readyState >= 2) void video.play()
}, 500)

video.addEventListener('loadedmetadata', layout)
video.requestVideoFrameCallback(onFrame)
canvas.addEventListener('click', () => {
  userPaused = video.paused ? (void video.play(), false) : (video.pause(), true)
})

declare global {
  interface Window {
    __gcc: {
      stats: typeof stats
      video: HTMLVideoElement
      grid: () => { cols: number; rows: number; wireMode: WireMode }
      checksum: () => number
    }
  }
}
window.__gcc = {
  stats,
  video,
  grid: () => ({ cols, rows, wireMode }),
  checksum: () => (state ? stateChecksum(state, wireMode) : -1),
}
