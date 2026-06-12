// glyphcast entry. Two engines: gpu = requestVideoFrameCallback ->
// renderer_gl direct mode (video texture encoded in-shader, zero CPU/frame);
// dom = rAF gated on video.currentTime -> CPU encode -> dirty-row innerHTML.
// Owns grid math (char aspect measured from the real font), control panel,
// stats, and the window.__gc debug handle used for programmatic verification.
// NOT responsible for: encoding (encode.ts), rendering (render.ts/renderer_gl.ts).
// Test strategy: live browser smoke via window.__gc asserts + PSNR vs source.

import { encodeCells, encodeFrame, frameToPlainText, sharpen, type Mode } from './encode'
import { createRenderer } from './render'
import { createRendererGL } from './renderer_gl'
import { createSampler } from './sampler'
import { createWireState, deflatedSize, pack, statesEqual, unpack, type WireMode } from './wire'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const stage = $<HTMLPreElement>('stage')
const glCanvas = $<HTMLCanvasElement>('glcanvas')
const video = $<HTMLVideoElement>('video')
const wrap = $<HTMLDivElement>('wrap')
const statsEl = $<HTMLSpanElement>('stats')

const FONT = 'Menlo, Consolas, monospace'

function measureCharRatio(): number {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = `100px ${FONT}`
  return ctx.measureText('▀').width / 100
}
const CHAR_RATIO = measureCharRatio()

type Engine = 'gpu' | 'dom'

let engine: Engine = 'gpu'
let mode: Mode = 'quadrant'
let cols = 640
let rows = 0
let qShift = 0
let sharpAmt = 0
let fgBuf = new Uint8Array(0)
let bgBuf = new Uint8Array(0)

const sampler = createSampler()
const renderer = createRenderer(stage)
const glRenderer = createRendererGL(glCanvas)

function layout() {
  const vw = video.videoWidth || 16
  const vh = video.videoHeight || 9
  rows = Math.max(1, Math.round(cols * CHAR_RATIO * (vh / vw)))
  const fs = wrap.clientWidth / (cols * CHAR_RATIO)
  stage.style.fontSize = `${fs}px`
  stage.style.lineHeight = `${fs}px`
  const n = cols * rows * 4
  if (fgBuf.length !== n) {
    fgBuf = new Uint8Array(n)
    bgBuf = new Uint8Array(n)
  }
  glRenderer.resize(wrap.clientWidth, rows * fs)
  stage.style.display = engine === 'dom' ? '' : 'none'
  glCanvas.style.display = engine === 'gpu' ? '' : 'none'
  redraw()
}

const stats = { fps: 0, encMs: 0, paintMs: 0, changedRows: 0, spans: 0, htmlBytes: 0, frames: 0 }
let lastFrameAt = 0

function frame() {
  const t0 = performance.now()
  const sx = mode === 'quadrant' ? 2 : 1
  const img = sampler.sample(video, cols * sx, rows * 2)
  sharpen(img, sharpAmt)
  const f = encodeFrame(img, cols, rows, mode, qShift)
  const t1 = performance.now()
  stats.changedRows = renderer.render(f.rows)
  stats.spans = f.spans
  stats.htmlBytes = f.htmlBytes
  const t2 = performance.now()

  if (lastFrameAt) stats.fps = stats.fps * 0.9 + (1000 / (t0 - lastFrameAt)) * 0.1
  lastFrameAt = t0
  stats.encMs = stats.encMs * 0.9 + (t1 - t0) * 0.1
  stats.paintMs = stats.paintMs * 0.9 + (t2 - t1) * 0.1
  stats.frames++

  statsEl.textContent =
    `${stats.fps.toFixed(0)} fps · ${cols}×${rows} = ${(cols * rows).toLocaleString()} cells · ` +
    `enc ${stats.encMs.toFixed(1)}ms · paint ${stats.paintMs.toFixed(1)}ms · ` +
    `${stats.changedRows}/${rows} rows · ${stats.spans.toLocaleString()} spans · ${(stats.htmlBytes / 1024).toFixed(0)}KB DOM`
}

function gpuFrame() {
  glRenderer.renderDirect(video, cols, rows, mode, qShift, sharpAmt)
  stats.frames++
}

let lastT = -1
function loop() {
  requestAnimationFrame(loop)
  if (engine !== 'dom') return
  if (video.readyState < 2) return
  if (video.currentTime === lastT) return
  lastT = video.currentTime
  frame()
}

function onVideoFrame(now: number) {
  if (engine === 'gpu' && video.readyState >= 2) {
    gpuFrame()
    if (lastFrameAt) stats.fps = stats.fps * 0.9 + (1000 / (now - lastFrameAt)) * 0.1
    lastFrameAt = now
    statsEl.textContent =
      `${stats.fps.toFixed(0)} fps · ${cols}×${rows} = ${(cols * rows).toLocaleString()} cells · ` +
      `gpu direct (0ms CPU) · 1 draw call`
  }
  video.requestVideoFrameCallback(onVideoFrame)
}

// redraw once outside the video-frame stream (paused slider tweaks, resize)
function redraw() {
  if (engine === 'gpu' && video.readyState >= 2) gpuFrame()
}

video.addEventListener('loadedmetadata', layout)
window.addEventListener('resize', layout)
layout()
loop()
video.requestVideoFrameCallback(onVideoFrame)

const playpause = $<HTMLButtonElement>('playpause')
function togglePlay() {
  if (video.paused) void video.play()
  else video.pause()
  playpause.textContent = video.paused ? 'play' : 'pause'
}
playpause.addEventListener('click', togglePlay)
stage.addEventListener('click', () => {
  if (window.getSelection()?.toString()) return
  togglePlay()
})
glCanvas.addEventListener('click', togglePlay)

$<HTMLSelectElement>('engine').addEventListener('change', (e) => {
  engine = (e.target as HTMLSelectElement).value as Engine
  layout()
})
$<HTMLSelectElement>('mode').addEventListener('change', (e) => {
  mode = (e.target as HTMLSelectElement).value as Mode
  redraw()
})
$<HTMLInputElement>('cols').addEventListener('input', (e) => {
  cols = Number((e.target as HTMLInputElement).value)
  $('colsv').textContent = String(cols)
  layout()
})
$<HTMLInputElement>('quant').addEventListener('input', (e) => {
  qShift = Number((e.target as HTMLInputElement).value)
  redraw()
})
$<HTMLInputElement>('sharp').addEventListener('input', (e) => {
  sharpAmt = Number((e.target as HTMLInputElement).value) / 10
  redraw()
})
$<HTMLInputElement>('glow').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  stage.style.textShadow = v > 0 ? `0 0 ${v}px` : 'none'
})
$<HTMLButtonElement>('copy').addEventListener('click', () => {
  if (video.readyState < 2) return
  const img = sampler.sample(video, cols * (mode === 'quadrant' ? 2 : 1), rows * 2)
  void navigator.clipboard.writeText(frameToPlainText(img, cols, rows))
})
const file = $<HTMLInputElement>('file')
$<HTMLButtonElement>('open').addEventListener('click', () => file.click())
file.addEventListener('change', () => {
  const f = file.files?.[0]
  if (!f) return
  video.src = URL.createObjectURL(f)
  void video.play()
  playpause.textContent = 'pause'
})

declare global {
  interface Window {
    __gc: {
      stats: typeof stats
      video: HTMLVideoElement
      grid: () => { cols: number; rows: number; mode: Mode; engine: Engine }
      setMode: (m: Mode) => void
      setEngine: (e: Engine) => void
      setCols: (c: number) => void
      plainText: () => string
      bench: (n: number) => { iters: number; totalMs: number; msPerFrame: number; maxFps: number }
      benchGl: (n: number) => { iters: number; totalMs: number; msPerFrame: number; maxFps: number }
      benchCells: (n: number) => { iters: number; totalMs: number; msPerFrame: number; maxFps: number }
      benchWire: (opts: { frames: number; cols: number; mode: Mode; wireMode: WireMode; fps: number }) => Promise<{
        frames: number; cells: number; keyBytes: number; avgDeltaBytes: number; rawKbps: number; deflateKbps: number; roundtripOk: boolean
      }>
      redraw: () => void
    }
  }
}
window.__gc = {
  stats,
  video,
  grid: () => ({ cols, rows, mode, engine }),
  setMode: (m) => (mode = m),
  setEngine: (e) => {
    engine = e
    layout()
  },
  setCols: (c) => {
    cols = c
    layout()
  },
  plainText: () => {
    if (video.readyState < 2) return ''
    const img = sampler.sample(video, cols * (mode === 'quadrant' ? 2 : 1), rows * 2)
    return frameToPlainText(img, cols, rows)
  },
  bench: (n: number) => {
    const q0 = qShift
    const t0 = performance.now()
    for (let i = 0; i < n; i++) {
      qShift = i % 2 === 0 ? 2 : 3
      frame()
    }
    const totalMs = performance.now() - t0
    qShift = q0
    return { iters: n, totalMs, msPerFrame: totalMs / n, maxFps: 1000 / (totalMs / n) }
  },
  benchGl: (n: number) => {
    const t0 = performance.now()
    for (let i = 0; i < n; i++) glRenderer.renderDirect(video, cols, rows, mode, qShift, sharpAmt)
    glRenderer.finish()
    const totalMs = performance.now() - t0
    return { iters: n, totalMs, msPerFrame: totalMs / n, maxFps: 1000 / (totalMs / n) }
  },
  benchWire: async ({ frames, cols: wcols, mode: wmode, wireMode, fps }) => {
    const wasPaused = video.paused
    video.pause()
    const t0 = video.currentTime
    const wrows = Math.max(1, Math.round(wcols * CHAR_RATIO * (video.videoHeight / video.videoWidth)))
    const n = wcols * wrows
    const sx = wmode === 'quadrant' ? 2 : 1
    const wfg = new Uint8Array(n * 4)
    const wbg = new Uint8Array(n * 4)
    const sender = createWireState(wcols, wrows)
    const receiver = createWireState(wcols, wrows)
    const seek = (t: number) =>
      new Promise<void>((res) => {
        video.addEventListener('seeked', () => res(), { once: true })
        video.currentTime = t
      })
    const packets: Uint8Array[] = []
    let keyBytes = 0
    let deltaBytes = 0
    let roundtripOk = true
    for (let f = 0; f < frames; f++) {
      await seek(1 + f / fps)
      const img = sampler.sample(video, wcols * sx, wrows * 2)
      encodeCells(img, wcols, wrows, wmode, 0, wfg, wbg)
      const pkt = pack(sender, wfg, wbg, wireMode)
      packets.push(pkt)
      unpack(pkt, receiver)
      if (f === 0) keyBytes = pkt.length
      else deltaBytes += pkt.length
      if (!statesEqual(sender, receiver, wireMode)) roundtripOk = false
    }
    const deflate = await deflatedSize(packets)
    await seek(t0)
    if (!wasPaused) void video.play()
    const avgDeltaBytes = frames > 1 ? deltaBytes / (frames - 1) : 0
    return {
      frames,
      cells: n,
      keyBytes,
      avgDeltaBytes: Math.round(avgDeltaBytes),
      rawKbps: Math.round((avgDeltaBytes * fps * 8) / 1000),
      deflateKbps: Math.round(((deflate / frames) * fps * 8) / 1000),
      roundtripOk,
    }
  },
  benchCells: (n: number) => {
    const sx = mode === 'quadrant' ? 2 : 1
    const t0 = performance.now()
    for (let i = 0; i < n; i++) {
      const img = sampler.sample(video, cols * sx, rows * 2)
      sharpen(img, sharpAmt)
      encodeCells(img, cols, rows, mode, qShift, fgBuf, bgBuf)
      glRenderer.render(fgBuf, bgBuf, cols, rows)
    }
    glRenderer.finish()
    const totalMs = performance.now() - t0
    return { iters: n, totalMs, msPerFrame: totalMs / n, maxFps: 1000 / (totalMs / n) }
  },
  redraw,
}
