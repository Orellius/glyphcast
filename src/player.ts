// glyphTV player: one source (video OR image, default /demo1080.mp4, drop or
// open anything), every renderer as a segmented switcher - octant/sextant/
// quadrant/halfblock/ascii GPU-direct, OLED emitters, the two honest wire
// roundtrip tiers - plus "grid" running all of them in parallel with chips.
// Cell-path panes re-encode only when the source produced a new frame or a
// control changed; GPU-direct panes are free every rAF.
// NOT responsible for: streaming (cast/view), wire format.
// Test strategy: live browser smoke - panes render for video AND image
// sources, glErr 0, fps in stats, mode switching keeps working.

import { encodeCells, sampleX, sampleY, type Mode } from './encode'
import { measureCharRatio, rowsFor } from './grid'
import { createRendererGL } from './renderer_gl'
import { createSampler } from './sampler'
import { createWireState, pack, stateToCells, unpack, type WireDepth, type WireState } from './wire'

type PaneKind = 'direct' | 'oled' | 'wire'
type PaneSpec = { key: string; label: string; mode: Mode; kind: PaneKind; depth?: WireDepth }

const SPECS: PaneSpec[] = [
  { key: 'octant', label: 'octant', mode: 'octant', kind: 'direct' },
  { key: 'sextant', label: 'sextant', mode: 'sextant', kind: 'direct' },
  { key: 'quadrant', label: 'quadrant', mode: 'quadrant', kind: 'direct' },
  { key: 'halfblock', label: 'halfblock', mode: 'halfblock', kind: 'direct' },
  { key: 'ascii', label: 'ascii', mode: 'ascii', kind: 'direct' },
  { key: 'oled', label: 'OLED', mode: 'octant', kind: 'oled' },
  { key: 'wire565', label: 'wire 565', mode: 'octant', kind: 'wire', depth: '565' },
  { key: 'wire888', label: 'wire 888', mode: 'octant', kind: 'wire', depth: '888' },
]

const video = document.getElementById('video') as HTMLVideoElement
const gridEl = document.getElementById('grid') as HTMLDivElement
const statsEl = document.getElementById('stats') as HTMLSpanElement
const modesEl = document.getElementById('modes') as HTMLDivElement
const colsInput = document.getElementById('cols') as HTMLInputElement
const colsV = document.getElementById('colsv') as HTMLSpanElement

const CHAR_RATIO = measureCharRatio()

type Source = HTMLVideoElement | HTMLImageElement
let source: Source = video
let view = 'octant'
let singleCols = 800
let dirty = true

type Pane = PaneSpec & {
  canvas: HTMLCanvasElement
  gl: ReturnType<typeof createRendererGL>
  sampler: ReturnType<typeof createSampler>
  cols: number
  rows: number
  fg: Uint8Array
  bg: Uint8Array
  sender?: WireState
  recv?: WireState
}

let panes: Pane[] = []

const srcW = () => (source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth) || 16
const srcH = () => (source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight) || 9
const srcReady = () => (source instanceof HTMLVideoElement ? source.readyState >= 2 : source.complete && source.naturalWidth > 0)

// mode switcher
for (const s of [...SPECS, { key: 'grid', label: 'grid — all', mode: 'octant' as Mode, kind: 'direct' as PaneKind }]) {
  const b = document.createElement('button')
  b.textContent = s.label
  b.dataset.key = s.key
  b.addEventListener('click', () => {
    view = s.key
    for (const x of modesEl.children) x.classList.toggle('on', (x as HTMLElement).dataset.key === view)
    buildPanes()
  })
  modesEl.appendChild(b)
}
;(modesEl.querySelector('[data-key="octant"]') as HTMLElement).classList.add('on')

function togglePlay() {
  if (!(source instanceof HTMLVideoElement)) return
  if (source.paused) void source.play()
  else source.pause()
}

function buildPanes() {
  gridEl.querySelectorAll('.pane').forEach((el) => el.remove())
  panes = []
  const specs = view === 'grid' ? SPECS : SPECS.filter((s) => s.key === view)
  gridEl.style.gridTemplateColumns = view === 'grid' ? 'repeat(3, 1fr)' : '1fr'
  for (const s of specs) {
    const cell = document.createElement('div')
    cell.className = 'pane'
    const canvas = document.createElement('canvas')
    const chip = document.createElement('span')
    chip.className = 'chip'
    cell.appendChild(canvas)
    cell.appendChild(chip)
    gridEl.appendChild(cell)
    canvas.addEventListener('click', togglePlay)
    const gl = createRendererGL(canvas)
    const p: Pane = {
      ...s,
      canvas,
      gl,
      sampler: createSampler(),
      cols: view === 'grid' ? 320 : singleCols,
      rows: 0,
      fg: new Uint8Array(0),
      bg: new Uint8Array(0),
    }
    if (s.kind === 'oled') gl.setOled(true, 2, sampleY(s.mode), 2.6)
    panes.push(p)
    layoutPane(p, cell, chip)
  }
  dirty = true
}

function layoutPane(p: Pane, cell: HTMLDivElement, chip: HTMLSpanElement) {
  p.rows = rowsFor(p.cols, CHAR_RATIO, srcW(), srcH())
  const n = p.cols * p.rows * 4
  p.fg = new Uint8Array(n)
  p.bg = new Uint8Array(n)
  if (p.kind === 'wire') {
    p.sender = createWireState(p.cols, p.rows)
    p.recv = createWireState(p.cols, p.rows)
  }
  const cw = cell.clientWidth || 400
  const chH = cell.clientHeight || 300
  const fs = Math.min(cw / (p.cols * CHAR_RATIO), chH / p.rows)
  p.gl.resize(p.cols * CHAR_RATIO * fs, p.rows * fs)
  chip.textContent = `${p.label} · ${p.cols}×${p.rows}`
}

function relayout() {
  const cells = gridEl.querySelectorAll<HTMLDivElement>('.pane')
  panes.forEach((p, i) => {
    const cell = cells[i]
    if (cell) layoutPane(p, cell, cell.querySelector('.chip')!)
  })
  dirty = true
}

const stats = { fps: 0, frames: 0 }
let lastAt = 0
let lastT = -1

function onFrame(now: number) {
  requestAnimationFrame(onFrame)
  if (!srcReady()) return
  const t = source instanceof HTMLVideoElement ? source.currentTime : 0
  const fresh = t !== lastT || dirty
  if (!fresh) return
  lastT = t
  dirty = false
  for (const p of panes) {
    if (p.kind === 'direct') {
      p.gl.renderDirect(source, p.cols, p.rows, p.mode, 0, 0)
    } else if (p.kind === 'oled') {
      const img = p.sampler.sample(source, p.cols * sampleX(p.mode), p.rows * sampleY(p.mode))
      encodeCells(img, p.cols, p.rows, p.mode, 0, p.fg, p.bg)
      p.gl.render(p.fg, p.bg, p.cols, p.rows, p.mode === 'octant')
    } else if (p.sender && p.recv) {
      const img = p.sampler.sample(source, p.cols * sampleX(p.mode), p.rows * sampleY(p.mode))
      encodeCells(img, p.cols, p.rows, p.mode, 0, p.fg, p.bg)
      const pkt = pack(p.sender, p.fg, p.bg, 'color', p.mode === 'octant', p.depth)
      unpack(pkt, p.recv)
      stateToCells(p.recv, 'color', p.fg, p.bg, p.depth)
      p.gl.render(p.fg, p.bg, p.cols, p.rows, p.mode === 'octant')
    }
  }
  stats.frames++
  if (lastAt) stats.fps = stats.fps * 0.9 + (1000 / (now - lastAt)) * 0.1
  lastAt = now
  const kind = source instanceof HTMLVideoElement ? (source.paused ? 'paused — click to play' : 'playing') : 'image'
  statsEl.textContent = `${panes.length}× ${view} · ${stats.fps.toFixed(0)} fps · ${srcW()}×${srcH()} source · ${kind}`
}

colsInput.addEventListener('input', () => {
  singleCols = Number(colsInput.value)
  colsV.textContent = String(singleCols)
  if (view !== 'grid') {
    for (const p of panes) p.cols = singleCols
    relayout()
  }
})

function openFile(f: File) {
  const url = URL.createObjectURL(f)
  if (f.type.startsWith('image/')) {
    const img = new Image()
    img.onload = () => {
      source = img
      video.pause()
      lastT = -1
      relayout()
    }
    img.src = url
  } else {
    source = video
    video.src = url
    void video.play()
    lastT = -1
    relayout()
  }
}

const file = document.getElementById('file') as HTMLInputElement
document.getElementById('open')!.addEventListener('click', () => file.click())
file.addEventListener('change', () => {
  if (file.files?.[0]) openFile(file.files[0])
})
document.addEventListener('dragover', (e) => {
  e.preventDefault()
  document.body.classList.add('dropping')
})
document.addEventListener('dragleave', () => document.body.classList.remove('dropping'))
document.addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dropping')
  if (e.dataTransfer?.files?.[0]) openFile(e.dataTransfer.files[0])
})

video.addEventListener('loadedmetadata', relayout)
window.addEventListener('resize', relayout)

let kickTries = 0
const kick = setInterval(() => {
  if (source !== video || !video.paused) {
    clearInterval(kick)
    return
  }
  if (video.readyState < 2) return
  if (++kickTries > 5) {
    clearInterval(kick)
    statsEl.textContent = 'autoplay blocked — click the picture to play'
    return
  }
  void video.play().catch(() => {})
}, 400)

buildPanes()
requestAnimationFrame(onFrame)

declare global {
  interface Window {
    __gcp: {
      stats: typeof stats
      video: HTMLVideoElement
      panes: () => { key: string; cols: number; rows: number }[]
      setView: (v: string) => void
      setCols: (c: number) => void
    }
  }
}
window.__gcp = {
  stats,
  video,
  panes: () => panes.map((p) => ({ key: p.key, cols: p.cols, rows: p.rows })),
  setView: (v) => {
    view = v
    for (const x of modesEl.children) x.classList.toggle('on', (x as HTMLElement).dataset.key === v)
    buildPanes()
  },
  setCols: (c) => {
    singleCols = c
    colsInput.value = String(c)
    colsV.textContent = String(c)
    if (view !== 'grid') {
      for (const p of panes) p.cols = c
      relayout()
    }
  },
}
