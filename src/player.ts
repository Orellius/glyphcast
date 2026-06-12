// glyphTV player: one video, every renderer we have, side by side. A dropdown
// picks a single renderer fullscreen or "grid" runs them all in parallel,
// each pane labeled with a chip. GPU-direct panes cost no CPU; the OLED pane
// runs the cell path (encodeCells) because emitter emulation lives in the
// cell shader. No tuner knobs by design - this is the comparison lab.
// NOT responsible for: streaming (cast/view), wire format.
// Test strategy: live browser smoke - all panes render, glErr 0, fps in stats.

import { encodeCells, sampleX, sampleY, type Mode } from './encode'
import { measureCharRatio, rowsFor } from './grid'
import { createRendererGL } from './renderer_gl'
import { createSampler } from './sampler'

type PaneKind = 'direct' | 'oled'
type PaneSpec = { key: string; label: string; mode: Mode; kind: PaneKind }

const SPECS: PaneSpec[] = [
  { key: 'octant', label: 'octant 2×4', mode: 'octant', kind: 'direct' },
  { key: 'sextant', label: 'sextant 2×3', mode: 'sextant', kind: 'direct' },
  { key: 'quadrant', label: 'quadrant 2×2', mode: 'quadrant', kind: 'direct' },
  { key: 'halfblock', label: 'halfblock', mode: 'halfblock', kind: 'direct' },
  { key: 'ascii', label: 'ascii ramp', mode: 'ascii', kind: 'direct' },
  { key: 'oled', label: 'OLED emitters (octant)', mode: 'octant', kind: 'oled' },
]

const video = document.getElementById('video') as HTMLVideoElement
const gridEl = document.getElementById('grid') as HTMLDivElement
const statsEl = document.getElementById('stats') as HTMLSpanElement
const select = document.getElementById('renderer') as HTMLSelectElement

const CHAR_RATIO = measureCharRatio()

type Pane = PaneSpec & {
  canvas: HTMLCanvasElement
  gl: ReturnType<typeof createRendererGL>
  sampler: ReturnType<typeof createSampler>
  cols: number
  rows: number
  fg: Uint8Array
  bg: Uint8Array
}

let panes: Pane[] = []
let view = 'grid'

for (const s of SPECS) {
  const o = document.createElement('option')
  o.value = s.key
  o.textContent = s.label
  select.appendChild(o)
}
const all = document.createElement('option')
all.value = 'grid'
all.textContent = 'grid — all renderers'
select.appendChild(all)
select.value = 'grid'

function togglePlay() {
  if (video.paused) void video.play()
  else video.pause()
}

function buildPanes() {
  for (const p of panes) p.canvas.remove()
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
    const cols = view === 'grid' ? 320 : 800
    const p: Pane = { ...s, canvas, gl, sampler: createSampler(), cols, rows: 0, fg: new Uint8Array(0), bg: new Uint8Array(0) }
    if (s.kind === 'oled') gl.setOled(true, 2, sampleY(s.mode), 2.6)
    panes.push(p)
    layoutPane(p, cell, chip)
  }
}

function layoutPane(p: Pane, cell: HTMLDivElement, chip: HTMLSpanElement) {
  const vw = video.videoWidth || 16
  const vh = video.videoHeight || 9
  p.rows = rowsFor(p.cols, CHAR_RATIO, vw, vh)
  const n = p.cols * p.rows * 4
  p.fg = new Uint8Array(n)
  p.bg = new Uint8Array(n)
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
}

const stats = { fps: 0, frames: 0 }
let lastAt = 0

function onFrame(now: number) {
  if (video.readyState >= 2) {
    for (const p of panes) {
      if (p.kind === 'direct') {
        p.gl.renderDirect(video, p.cols, p.rows, p.mode, 0, 0)
      } else {
        const img = p.sampler.sample(video, p.cols * sampleX(p.mode), p.rows * sampleY(p.mode))
        encodeCells(img, p.cols, p.rows, p.mode, 0, p.fg, p.bg)
        p.gl.render(p.fg, p.bg, p.cols, p.rows, p.mode === 'octant')
      }
    }
    stats.frames++
    if (lastAt) stats.fps = stats.fps * 0.9 + (1000 / (now - lastAt)) * 0.1
    lastAt = now
    statsEl.textContent =
      `${panes.length} renderer${panes.length > 1 ? 's' : ''} in parallel · ${stats.fps.toFixed(0)} fps · ` +
      `${video.paused ? 'paused (click a pane)' : 'playing'}`
  }
  video.requestVideoFrameCallback(onFrame)
}

select.addEventListener('change', () => {
  view = select.value
  buildPanes()
})
video.addEventListener('loadedmetadata', relayout)
window.addEventListener('resize', relayout)

const file = document.getElementById('file') as HTMLInputElement
document.getElementById('open')!.addEventListener('click', () => file.click())
file.addEventListener('change', () => {
  const f = file.files?.[0]
  if (!f) return
  video.src = URL.createObjectURL(f)
  void video.play()
})

let kickTries = 0
const kick = setInterval(() => {
  if (!video.paused) {
    clearInterval(kick)
    return
  }
  if (video.readyState < 2) return
  if (++kickTries > 5) {
    clearInterval(kick)
    statsEl.textContent = 'autoplay blocked — click any pane to play'
    return
  }
  void video.play().catch(() => {})
}, 400)

buildPanes()
video.requestVideoFrameCallback(onFrame)

declare global {
  interface Window {
    __gcp: { stats: typeof stats; video: HTMLVideoElement; panes: () => { key: string; cols: number; rows: number }[]; setView: (v: string) => void }
  }
}
window.__gcp = {
  stats,
  video,
  panes: () => panes.map((p) => ({ key: p.key, cols: p.cols, rows: p.rows })),
  setView: (v) => {
    view = v
    select.value = v
    buildPanes()
  },
}
