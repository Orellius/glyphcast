// glyphTV viewer: pure receiver and the TV itself. No <video>, no sampling -
// just WS packets unpacked into receiver state, expanded to RGBA cell
// buffers, one GL draw per packet. Grid dims come from the packet header.
// Fullscreen black shell, stats fade when idle, click = fullscreen toggle.
// URL knobs: ?ws=ws://host:8788&ch=main&scan=0.25&gap=0.15&glow=0.3
// NOT responsible for: encoding or capture - a viewer never sees pixels.
// Test strategy: E2E checksum convergence with cast.ts via window.__gcv.

import { measureCharRatio } from './grid'
import { createRendererGL } from './renderer_gl'
import { createWireState, stateChecksum, stateToCells, unpack, type WireDepth, type WireMode, type WireState } from './wire'

const q = new URLSearchParams(location.search)
const wsUrl = q.get('ws') ?? 'ws://localhost:8788'
const ch = q.get('ch') ?? 'main'
// all display FX opt-in: scan/gap read as black grid lines, glow lifts
// blacks (washed-out look). Default = the pure picture.
const fx = {
  scan: Number(q.get('scan') ?? 0),
  gap: Number(q.get('gap') ?? 0),
  glow: Number(q.get('glow') ?? 0),
}
// OLED emitter emulation (?oled=1): each glyph subpixel renders as an RGB
// triad with black matrix - the microscope look; gain compensates matrix area
const oled = q.get('oled') === '1'
const oledGain = Number(q.get('oledgain') ?? 2.6)

const canvas = document.getElementById('glcanvas') as HTMLCanvasElement
const statsEl = document.getElementById('stats') as HTMLSpanElement

const CHAR_RATIO = measureCharRatio()
const gl = createRendererGL(canvas, { p3: q.get('p3') === '1' })
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
let lastPage: boolean | null = null
let fg = new Uint8Array(0)
let bg = new Uint8Array(0)

const stats = { frames: 0, recvBytes: 0, kbps: 0, fps: 0, cells: 0, audioPkts: 0, audioCfg: false }
let lastAt = 0
let winBytes = 0
let winAt = performance.now()

function layout(cols: number, rows: number) {
  const wrap = document.getElementById('wrap') as HTMLDivElement
  // fit the cell grid inside the viewport preserving aspect
  const fs = Math.min(wrap.clientWidth / (cols * CHAR_RATIO), wrap.clientHeight / rows)
  gl.resize(cols * CHAR_RATIO * fs, rows * fs)
}

// audio: packets tagged with bit 7 (0x81 = AudioDecoder config JSON, 0x80 =
// AAC frame + f64 timestamp). AudioContext needs a gesture - the unmute
// button - then frames are decoded and scheduled on the context clock.
type AudioCfg = { codec: string; sampleRate: number; channels: number; desc?: string }
let audioCtx: AudioContext | null = null
let audioDec: AudioDecoder | null = null
let pendingCfg: AudioCfg | null = null
let aBase = -1
let aT0 = 0
const unmuteBtn = document.getElementById('unmute') as HTMLButtonElement

function playAudio(ad: AudioData) {
  if (!audioCtx) {
    ad.close()
    return
  }
  const buf = audioCtx.createBuffer(ad.numberOfChannels, ad.numberOfFrames, ad.sampleRate)
  const plane = new Float32Array(ad.numberOfFrames)
  for (let c = 0; c < ad.numberOfChannels; c++) {
    ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
    buf.copyToChannel(plane, c)
  }
  if (aBase < 0 || aBase + (ad.timestamp - aT0) / 1e6 < audioCtx.currentTime) {
    // first chunk, loop wrap, or we fell behind: re-anchor with a small lead
    aBase = audioCtx.currentTime + 0.25
    aT0 = ad.timestamp
  }
  const src = audioCtx.createBufferSource()
  src.buffer = buf
  src.connect(audioCtx.destination)
  src.start(aBase + (ad.timestamp - aT0) / 1e6)
  ad.close()
}

function setupAudioDecoder() {
  if (!audioCtx || !pendingCfg) return
  audioDec?.close()
  const cfg: AudioDecoderConfig = {
    codec: pendingCfg.codec,
    sampleRate: pendingCfg.sampleRate,
    numberOfChannels: pendingCfg.channels,
  }
  if (pendingCfg.desc) cfg.description = Uint8Array.from(atob(pendingCfg.desc), (c) => c.charCodeAt(0))
  audioDec = new AudioDecoder({ output: playAudio, error: (err) => (statsEl.textContent = `audio error: ${err.message}`) })
  audioDec.configure(cfg)
  aBase = -1
}

unmuteBtn.addEventListener('click', () => {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    setupAudioDecoder()
    unmuteBtn.textContent = '🔊 on'
  } else {
    void audioCtx.close()
    audioCtx = null
    audioDec?.close()
    audioDec = null
    unmuteBtn.textContent = '🔇 unmute'
  }
})

const ws = new WebSocket(`${wsUrl}/?role=view&ch=${encodeURIComponent(ch)}`)
ws.binaryType = 'arraybuffer'
ws.addEventListener('message', (e) => {
  if (typeof e.data === 'string') return
  const pkt = new Uint8Array(e.data as ArrayBuffer)
  if (pkt[0] & 0x80) {
    if (pkt[0] === 0x81) {
      pendingCfg = JSON.parse(new TextDecoder().decode(pkt.subarray(1))) as AudioCfg
      stats.audioCfg = true
      unmuteBtn.style.display = 'block'
      setupAudioDecoder()
    } else if (pkt[0] === 0x80) {
      stats.audioPkts++
      if (audioDec && audioDec.state === 'configured') {
        const ts = new DataView(pkt.buffer, pkt.byteOffset).getFloat64(1, true)
        audioDec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: pkt.subarray(9) }))
      }
    }
    return
  }
  wireMode = pkt[0] & 1 ? 'color' : 'mono'
  const octantPage = (pkt[0] & 2) !== 0
  const depth: WireDepth = pkt[0] & 4 ? '888' : '565'
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
  stateToCells(state, wireMode, fg, bg, depth)
  if (oled && octantPage !== lastPage) {
    gl.setOled(true, 2, octantPage ? 4 : 2, oledGain)
    lastPage = octantPage
  }
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
