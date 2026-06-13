// glyphTV viewer: pure receiver and the TV itself. No <video>, no sampling -
// just WS packets unpacked into receiver state, expanded to RGBA cell
// buffers, one GL draw per packet. Grid dims come from the packet header.
// Fullscreen black shell, stats fade when idle, click = fullscreen toggle.
// URL knobs: ?ws=ws://host:8788&ch=main&scan=0.25&gap=0.15&glow=0.3
// NOT responsible for: encoding or capture - a viewer never sees pixels.
// Test strategy: E2E checksum convergence with cast.ts via window.__gcv.

import { GLYPH_CHARS } from './encode'
import { measureCharRatio } from './grid'
import { OCT_CHARS } from './octants'
import { createRendererGL } from './renderer_gl'
import { createWireState, stateChecksum, stateToCells, unpack, type WireDepth, type WireMode, type WireState } from './wire'

const q = new URLSearchParams(location.search)
const wsUrl = q.get('ws') ?? (['localhost', '127.0.0.1'].includes(location.hostname) ? 'ws://localhost:8788' : 'wss://relay.glyphcast.tv')
// channel ids are a constrained token: sanitise at the boundary so ch is safe
// to interpolate into the status strip and the relay query
const cleanCh = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'main'
let ch = cleanCh(q.get('ch') ?? 'main')
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
let oledGain = Number(q.get('oledgain') ?? 2.6)
let oledOn = oled

const canvas = document.getElementById('glcanvas') as HTMLCanvasElement
const statsEl = document.getElementById('stats') as HTMLSpanElement

const CHAR_RATIO = measureCharRatio()
const gl = createRendererGL(canvas, { p3: q.get('p3') === '1' })
gl.setFx(fx.scan, fx.gap, fx.glow)
// TV picture settings: ?sat=1.2&con=1.05&bri=1 (neutral = 1)
gl.setPicture(Number(q.get('sat') ?? 1), Number(q.get('con') ?? 1), Number(q.get('bri') ?? 1))

// TV shell: stats fade after idle, double-click toggles fullscreen,
// wheel = zoom-to-reveal (lean into the panel until emitters resolve),
// drag = pan while zoomed
let idleT = 0
function poke() {
  document.body.classList.remove('idle')
  clearTimeout(idleT)
  idleT = window.setTimeout(() => document.body.classList.add('idle'), 2500)
}
window.addEventListener('mousemove', poke)
poke()
canvas.addEventListener('dblclick', () => {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void document.documentElement.requestFullscreen()
})
window.addEventListener('resize', () => {
  if (state) layout(state.cols, state.rows)
})

let zoom = 1
let cx = 0.5
let cy = 0.5

function clampView() {
  const half = 0.5 / zoom
  cx = Math.min(Math.max(cx, half), 1 - half)
  cy = Math.min(Math.max(cy, half), 1 - half)
}

// repaint from the last received frame so zoom/pan respond between packets
function rerender() {
  gl.setZoom(zoom, cx, cy)
  if (state) gl.render(fg, bg, state.cols, state.rows, lastPage ?? false)
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const r = canvas.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    const prev = zoom
    zoom = Math.min(60, Math.max(1, zoom * Math.exp(-e.deltaY * 0.0022)))
    const k = prev / zoom
    cx = px - (px - cx) * k
    cy = py - (py - cy) * k
    clampView()
    rerender()
  },
  { passive: false },
)

let dragging = false
let lastX = 0
let lastY = 0
canvas.addEventListener('pointerdown', (e) => {
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || zoom === 1) return
  const r = canvas.getBoundingClientRect()
  cx -= (e.clientX - lastX) / (r.width * zoom)
  cy -= (e.clientY - lastY) / (r.height * zoom)
  lastX = e.clientX
  lastY = e.clientY
  clampView()
  rerender()
})
canvas.addEventListener('pointerup', () => (dragging = false))

// the proof tools: 'i' = live cell inspector (the character under your
// cursor, named, while the stream retypes it), 't' = dump the current frame
// as plain text
const inspectEl = document.getElementById('inspect') as HTMLDivElement
const inspGlyph = document.getElementById('inspGlyph') as HTMLSpanElement
const inspMeta = document.getElementById('inspMeta') as HTMLSpanElement
let inspecting = false
let mouseX = 0
let mouseY = 0

function cellChar(i: number): string {
  const g = state!.glyph[i]
  return (lastPageState ? OCT_CHARS[g] : GLYPH_CHARS[g]) ?? ' '
}

function updateInspector() {
  if (!inspecting || !state) return
  const r = canvas.getBoundingClientRect()
  const ux = (mouseX - r.left) / r.width
  const uy = (mouseY - r.top) / r.height
  if (ux < 0 || ux >= 1 || uy < 0 || uy >= 1) {
    inspectEl.style.display = 'none'
    return
  }
  // same zoom remap as the shader
  const zx = cx + (ux - cx) / zoom
  const zy = cy + (uy - cy) / zoom
  const col = Math.min(state.cols - 1, Math.floor(zx * state.cols))
  const row = Math.min(state.rows - 1, Math.floor(zy * state.rows))
  const i = row * state.cols + col
  const ch = cellChar(i)
  const cp = ch.codePointAt(0) ?? 32
  const f = state.fg[i]
  const b = state.bg[i]
  const hex6 = (v: number) => '#' + v.toString(16).padStart(6, '0')
  inspGlyph.textContent = ch === ' ' ? '␠' : ch
  inspMeta.style.whiteSpace = 'pre'
  inspMeta.textContent =
    `cell ${col},${row} · U+${cp.toString(16).toUpperCase().padStart(4, '0')}\n` +
    (wireMode === 'color' ? `fg ${hex6(f)} · bg ${hex6(b)}` : 'mono')
  inspectEl.style.display = 'block'
  inspectEl.style.left = `${Math.min(mouseX + 18, window.innerWidth - 180)}px`
  inspectEl.style.top = `${Math.min(mouseY + 18, window.innerHeight - 110)}px`
}

window.addEventListener('mousemove', (e) => {
  mouseX = e.clientX
  mouseY = e.clientY
  updateInspector()
})
setInterval(() => updateInspector(), 120) // live-refresh while the stream retypes

function dumpFrameAsText() {
  if (!state) return
  const lines: string[] = []
  for (let y = 0; y < state.rows; y++) {
    let line = ''
    for (let x = 0; x < state.cols; x++) line += cellChar(y * state.cols + x)
    lines.push(line)
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `glyphcast-frame-${state.cols}x${state.rows}.txt`
  a.click()
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'i') {
    inspecting = !inspecting
    if (!inspecting) inspectEl.style.display = 'none'
  }
  if (e.key === 't') dumpFrameAsText()
})

let state: WireState | null = null
let wireMode: WireMode = 'color'
let lastPage: boolean | null = null
let fg = new Uint8Array(0)
let bg = new Uint8Array(0)

const stats = { frames: 0, recvBytes: 0, kbps: 0, fps: 0, cells: 0, audioPkts: 0, audioCfg: false, glyphsPerSec: 0 }
let winTouched = 0
let lastPageState = false
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

// ---------- TV chrome: now-playing OSD, no-signal, power-on ----------
const osdEl = document.getElementById('osd') as HTMLDivElement
const nosignalEl = document.getElementById('nosignal') as HTMLDivElement
const wrapEl = document.getElementById('wrap') as HTMLDivElement
function showOsd() { osdEl.classList.add('show'); poke() }
function powerOn() { wrapEl.classList.add('powering'); setTimeout(() => wrapEl.classList.remove('powering'), 650) }
function showNoSignal() { nosignalEl.classList.add('show') }
function hideNoSignal() { nosignalEl.classList.remove('show') }

let ws: WebSocket
let gotFrame = false
let signalTimer = 0

function connect() {
  gotFrame = false
  clearTimeout(signalTimer)
  signalTimer = window.setTimeout(() => { if (!gotFrame) showNoSignal() }, 4000)
  ws = new WebSocket(`${wsUrl}/?role=view&ch=${encodeURIComponent(ch)}`)
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
    winTouched += unpack(pkt, state)
    lastPageState = octantPage
    stateToCells(state, wireMode, fg, bg, depth)
    if (oledOn && octantPage !== lastPage) {
      gl.setOled(true, 2, octantPage ? 4 : 2, oledGain)
      lastPage = octantPage
    }
    gl.render(fg, bg, cols, rows, octantPage)
    if (!gotFrame) {
      gotFrame = true
      hideNoSignal()
      powerOn()
      showOsd()
    }

    const now = performance.now()
    stats.frames++
    stats.recvBytes += pkt.length
    winBytes += pkt.length
    if (lastAt) stats.fps = stats.fps * 0.9 + (1000 / (now - lastAt)) * 0.1
    lastAt = now
    if (now - winAt > 500) {
      stats.kbps = Math.round((winBytes * 8) / (now - winAt))
      stats.glyphsPerSec = Math.round((winTouched * 1000) / (now - winAt))
      winBytes = 0
      winTouched = 0
      winAt = now
      statsEl.innerHTML =
        `<span class="seg live"><b>${ch}</b></span>` +
        `<span class="seg">${cols}×${rows} <b>${wireMode}</b></span>` +
        `<span class="seg"><b>${stats.fps.toFixed(0)}</b> fps</span>` +
        `<span class="seg"><b>${(stats.glyphsPerSec / 1000).toFixed(0)}k</b> glyphs/s</span>` +
        `<span class="seg"><b>${stats.kbps}</b> kbps</span>` +
        `<span class="spacer"></span>` +
        `<span class="seg">${stats.frames} frames · i inspect · t save</span>`
    }
  })
  ws.addEventListener('close', () => {
    document.body.classList.remove('idle')
    if (gotFrame) showNoSignal()
  })
}
connect()

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

// ---------- the remote: on-screen settings panel ----------
const panel = document.getElementById('panel') as HTMLElement
const num = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value)
const setInput = (id: string, val: number) => ((document.getElementById(id) as HTMLInputElement).value = String(val))
function togglePanel(open?: boolean) {
  panel.classList.toggle('open', open)
  poke()
}
document.getElementById('gear')!.addEventListener('click', () => togglePanel())
document.getElementById('panelClose')!.addEventListener('click', () => togglePanel(false))
document.getElementById('fs')!.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void document.documentElement.requestFullscreen()
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'm') togglePanel()
})

// slider positions come from any URL knobs; the uniforms were already applied above
setInput('fSat', Number(q.get('sat') ?? 1))
setInput('fCon', Number(q.get('con') ?? 1))
setInput('fBri', Number(q.get('bri') ?? 1))
setInput('fScan', fx.scan)
setInput('fGap', fx.gap)
setInput('fGlow', fx.glow)
setInput('fOgain', oledGain)

function bindRange(id: string, vid: string, fmt: (n: number) => string, apply: () => void) {
  const r = document.getElementById(id) as HTMLInputElement
  const v = document.getElementById(vid) as HTMLSpanElement
  const sync = () => (v.textContent = fmt(num(id)))
  r.addEventListener('input', () => {
    apply()
    sync()
    rerender()
  })
  sync()
}
const applyPic = () => gl.setPicture(num('fSat'), num('fCon'), num('fBri'))
const applyFx = () => gl.setFx(num('fScan'), num('fGap'), num('fGlow'))
bindRange('fSat', 'vSat', (n) => n.toFixed(2), applyPic)
bindRange('fCon', 'vCon', (n) => n.toFixed(2), applyPic)
bindRange('fBri', 'vBri', (n) => n.toFixed(2), applyPic)
bindRange('fScan', 'vScan', (n) => n.toFixed(2), applyFx)
bindRange('fGap', 'vGap', (n) => n.toFixed(2), applyFx)
bindRange('fGlow', 'vGlow', (n) => n.toFixed(2), applyFx)

// OLED emitter toggle + gain
const oledSw = document.getElementById('fOled') as HTMLButtonElement
const syncOledSw = () => {
  oledSw.classList.toggle('on', oledOn)
  oledSw.setAttribute('aria-checked', String(oledOn))
}
oledSw.addEventListener('click', () => {
  oledOn = !oledOn
  gl.setOled(oledOn, 2, lastPageState ? 4 : 2, oledGain)
  lastPage = oledOn ? lastPageState : null
  syncOledSw()
  rerender()
})
bindRange('fOgain', 'vOgain', (n) => n.toFixed(1), () => {
  oledGain = num('fOgain')
  if (oledOn) gl.setOled(true, 2, lastPageState ? 4 : 2, oledGain)
})
syncOledSw()

document.getElementById('resetView')!.addEventListener('click', () => {
  zoom = 1
  cx = 0.5
  cy = 0.5
  const reset = (id: string, val: number) => {
    setInput(id, val)
    ;(document.getElementById(id) as HTMLInputElement).dispatchEvent(new Event('input'))
  }
  reset('fSat', 1)
  reset('fCon', 1)
  reset('fBri', 1)
  reset('fScan', 0)
  reset('fGap', 0)
  reset('fGlow', 0)
  if (oledOn) {
    oledOn = false
    gl.setOled(false, 2, 2, oledGain)
    lastPage = null
    syncOledSw()
  }
  rerender()
})

// channel switcher
const chanInput = document.getElementById('chanInput') as HTMLInputElement
chanInput.value = ch
;(document.getElementById('osdCh') as HTMLElement).textContent = ch
;(document.getElementById('nsCh') as HTMLElement).textContent = ch
function tune() {
  const c = cleanCh(chanInput.value)
  chanInput.value = c
  if (c === ch && gotFrame) {
    togglePanel(false)
    return
  }
  ch = c
  ;(document.getElementById('osdCh') as HTMLElement).textContent = c
  ;(document.getElementById('nsCh') as HTMLElement).textContent = c
  try { ws.close() } catch { /* already closing */ }
  state = null
  hideNoSignal()
  connect()
  showOsd()
  togglePanel(false)
}
document.getElementById('chanGo')!.addEventListener('click', tune)
chanInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tune()
})
document.getElementById('nsRetry')!.addEventListener('click', () => {
  try { ws.close() } catch { /* already closing */ }
  hideNoSignal()
  connect()
})
