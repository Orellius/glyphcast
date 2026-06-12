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
import { createWireState, pack, stateChecksum, type WireMode, type WireState } from './wire'

const q = new URLSearchParams(location.search)
const cols = Number(q.get('cols') ?? 240)
const wireMode: WireMode = q.get('wire') === 'mono' ? 'mono' : 'color'
const wsUrl = q.get('ws') ?? 'ws://localhost:8788'
const mode: Mode = q.get('mode') === 'sextant' ? 'sextant' : 'quadrant'

const video = document.getElementById('video') as HTMLVideoElement
video.src = q.get('src') ?? '/bbb60.mp4'
const canvas = document.getElementById('glcanvas') as HTMLCanvasElement
const statsEl = document.getElementById('stats') as HTMLSpanElement

const CHAR_RATIO = measureCharRatio()
const sampler = createSampler()
const gl = createRendererGL(canvas)

let rows = 0
let fg = new Uint8Array(0)
let bg = new Uint8Array(0)
let state: WireState | null = null
let wantKey = false

const stats = { frames: 0, sentBytes: 0, kbps: 0, fps: 0 }
let lastAt = 0
let winBytes = 0
let winAt = performance.now()

const ws = new WebSocket(`${wsUrl}/?role=cast`)
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
}

let lastT = -1

function castFrame(now: number) {
  if (video.readyState < 2 || !state) return
  if (video.currentTime === lastT && !wantKey) return
  lastT = video.currentTime
  if (wantKey) {
    state.glyph.fill(255)
    wantKey = false
  }
  const img = sampler.sample(video, cols * sampleX(mode), rows * sampleY(mode))
  encodeCells(img, cols, rows, mode, 0, fg, bg)
  const pkt = pack(state, fg, bg, wireMode)
  if (ws.readyState === WebSocket.OPEN) ws.send(pkt)
  if (!document.hidden) gl.render(fg, bg, cols, rows)
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
      `cast · ${cols}×${rows} ${wireMode} · ${stats.fps.toFixed(0)} fps · ` +
      `${stats.kbps} kbps raw · ${stats.frames} frames · ws ${ws.readyState === 1 ? 'up' : 'down'}`
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
