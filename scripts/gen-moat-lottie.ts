// Generates public/moat/ignite.json - the moat-page hero Lottie. The mark is
// the same play-triangle the codec rasterizes into quadrant cells; here each
// cell is a Lottie group that pulses as a diagonal phosphor scan sweeps the
// grid. Cell coordinates are READ from public/favicon.svg so the animation is
// literally the brand, not a redraw. Skottie-safe (every shape wrapped in a
// `gr` with a trailing `tr`); rendered on the site by lottie-web (svg).
// NOT responsible for: page wiring (moat.ts) or the live codec demos.
// Regenerate, never hand-edit ignite.json:  bun scripts/gen-moat-lottie.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SVG = readFileSync(resolve(ROOT, 'public/favicon.svg'), 'utf8')

// ---- composition ----
const W = 512
const H = 512
const FR = 60
const L = 150 // loop length in frames (2.5s)

// phosphor green #3ddc84 and screen black #0a0a0c as 0-1 RGBA
const GREEN = [61 / 255, 220 / 255, 132 / 255, 1]
const BLACK = [10 / 255, 10 / 255, 12 / 255, 1]

// ---- the pulse wave ----
const O_BASE = 30
const O_PEAK = 100
const S_BASE = 78
const S_PEAK = 112
const WIN = 22 // half-width of the pulse, in frames

const ease = { i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } }

// circular distance on the loop, so the scan wraps seamlessly
function loopDist(t: number, peak: number): number {
  const d = Math.abs(((t - peak) % L) + L) % L
  return Math.min(d, L - d)
}
function pulse(t: number, peak: number, base: number, top: number): number {
  const d = loopDist(t, peak)
  if (d >= WIN) return base
  return base + (top - base) * 0.5 * (1 + Math.cos((Math.PI * d) / WIN))
}

type Rect = { x: number; y: number; w: number; h: number; col: number; row: number }
const rects: Rect[] = []
const re = /<rect[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/g
for (const m of SVG.matchAll(re)) {
  const x = +m[1]
  const y = +m[2]
  rects.push({ x, y, w: +m[3], h: +m[4], col: Math.round((x - 0.8) / 10), row: Math.round((y - 0.8) / 10) })
}

// map the 80-unit favicon grid into a centred 400px box of the 512 comp
const SCALE = 5
const MARK = 80 * SCALE
const OFF = (W - MARK) / 2
const CELL = 8.4 * SCALE
const RAD = 1.4 * SCALE
const maxPhase = 7 + 7 // cols 0..7 + rows 0..7

// sparse, seamless keyframes for one cell's pulse on prop (base/top)
function pulseKeys(peak: number, base: number, top: number, scalar: boolean) {
  const cand = new Set<number>([0, L])
  for (const k of [-L, 0, L]) for (const off of [-WIN, 0, WIN]) {
    const t = peak + k + off
    if (t > 0 && t < L) cand.add(Math.round(t))
  }
  const times = [...cand].sort((a, b) => a - b)
  return times.map((t, idx) => {
    const v = pulse(t, peak, base, top)
    const s = scalar ? [v] : [v, v, 100]
    return idx === times.length - 1 ? { t, s } : { t, s, ...ease }
  })
}

const cellGroups = rects.map((r) => {
  const cx = OFF + (r.x + r.w / 2) * SCALE
  const cy = OFF + (r.y + r.h / 2) * SCALE
  const peak = ((r.col + r.row) / maxPhase) * L
  return {
    ty: 'gr',
    nm: `cell-${r.col}-${r.row}`,
    it: [
      { ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [CELL, CELL] }, r: { a: 0, k: RAD } },
      { ty: 'fl', c: { a: 0, k: GREEN }, o: { a: 0, k: 100 } },
      {
        ty: 'tr',
        p: { a: 0, k: [cx, cy] },
        a: { a: 0, k: [0, 0] },
        s: { a: 1, k: pulseKeys(peak, S_BASE, S_PEAK, false) },
        r: { a: 0, k: 0 },
        o: { a: 1, k: pulseKeys(peak, O_BASE, O_PEAK, true) },
      },
    ],
  }
})

const markLayer = {
  ty: 4,
  nm: 'mark',
  ip: 0,
  op: L,
  st: 0,
  ks: {
    o: { a: 0, k: 100 },
    r: { a: 0, k: 0 },
    p: { a: 0, k: [W / 2, H / 2, 0] },
    a: { a: 0, k: [W / 2, H / 2, 0] },
    s: { a: 0, k: [100, 100, 100] },
  },
  shapes: cellGroups,
}

const bgLayer = {
  ty: 4,
  nm: 'background',
  ip: 0,
  op: L,
  st: 0,
  ks: {
    o: { a: 0, k: 100 },
    r: { a: 0, k: 0 },
    p: { a: 0, k: [W / 2, H / 2, 0] },
    a: { a: 0, k: [0, 0, 0] },
    s: { a: 0, k: [100, 100, 100] },
  },
  shapes: [
    {
      ty: 'gr',
      it: [
        { ty: 'rc', d: 1, p: { a: 0, k: [W / 2, H / 2] }, s: { a: 0, k: [W, H] }, r: { a: 0, k: 0 } },
        { ty: 'fl', c: { a: 0, k: BLACK }, o: { a: 0, k: 100 } },
        { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ],
    },
  ],
}

const lottie = { v: '5.7.0', fr: FR, ip: 0, op: L, w: W, h: H, nm: 'glyphcast-ignite', ddd: 0, assets: [], layers: [markLayer, bgLayer] }

const out = resolve(ROOT, 'public/moat/ignite.json')
writeFileSync(out, JSON.stringify(lottie))
console.log(`wrote ${out}: ${rects.length} cells, ${L}f @ ${FR}fps, ${(JSON.stringify(lottie).length / 1024).toFixed(1)}KB`)
