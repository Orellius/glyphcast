// Generates the four "moat door" micro-Lotties into public/moat/door{1..4}.json,
// each a small looping phosphor-green animation that dramatises one door's claim:
//   door1  a scan-line reading a block of glyph cells   (an AI reads it)
//   door2  a terminal typing blocks + a blinking cursor  (a terminal plays it)
//   door3  two identical byte-streams flowing in lockstep (the wire is lossless)
//   door4  a cell broadcasting concentric rings outward   (renders on anything)
// Transparent background (no bg layer) so each sits on its bento tile. Skottie-safe
// (every shape in a `gr` ending with a `tr`); rendered on the site by lottie-web.
// NOT responsible for: the hero ignite (gen-moat-lottie.ts) or page wiring.
// Regenerate, never hand-edit:  bun scripts/gen-door-lotties.ts

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT = resolve(import.meta.dirname, '..', 'public/moat')
const GREEN = [61 / 255, 220 / 255, 132 / 255, 1]
const ease = { i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } }
const W = 320
const H = 180

type KF = { t: number; s: number[]; h?: number; i?: unknown; o?: unknown }
// pairs: [frame, value(s)]. `hold` makes every segment a step (crisp on/off).
function keys(pairs: [number, number[]][], hold = false): KF[] {
  return pairs.map(([t, s], idx) => {
    if (idx === pairs.length - 1) return { t, s }
    return hold ? { t, s, h: 1 } : { t, s, ...ease }
  })
}
const stat = (v: number[]) => ({ a: 0, k: v })
const anim = (k: KF[]) => ({ a: 1, k })

function tr(p: number[], o: unknown = stat([100]), s: unknown = stat([100, 100])) {
  return { ty: 'tr', p: stat(p), a: stat([0, 0]), s, r: stat([0]), o }
}
function rectCell(size: number[], rad: number, color: number[], o: unknown, p: number[], s?: unknown) {
  return {
    ty: 'gr',
    it: [
      { ty: 'rc', d: 1, p: stat([0, 0]), s: stat(size), r: stat([rad]) },
      { ty: 'fl', c: stat(color), o: stat([100]) },
      tr(p, o, s),
    ],
  }
}
function layer(nm: string, shapes: unknown[], op: number) {
  return {
    ty: 4, nm, ip: 0, op, st: 0,
    ks: { o: stat([100]), r: stat([0]), p: stat([W / 2, H / 2, 0]), a: stat([W / 2, H / 2, 0]), s: stat([100, 100, 100]) },
    shapes,
  }
}
function doc(layers: unknown[], op: number, fr = 60) {
  return { v: '5.7.0', fr, ip: 0, op, w: W, h: H, ddd: 0, assets: [], layers }
}
function write(name: string, json: unknown) {
  const s = JSON.stringify(json)
  writeFileSync(resolve(OUT, name), s)
  return `${name} ${(s.length / 1024).toFixed(1)}KB`
}

// circular pulse for door1 cell glow, sparse + seamless (matches the hero ignite)
function pulseKeys(peak: number, L: number, win: number, base: number, top: number): KF[] {
  const cand = new Set<number>([0, L])
  for (const k of [-L, 0, L]) for (const off of [-win, 0, win]) {
    const t = peak + k + off
    if (t > 0 && t < L) cand.add(Math.round(t))
  }
  return [...cand].sort((a, b) => a - b).map((t) => {
    const d0 = Math.abs(((t - peak) % L) + L) % L
    const d = Math.min(d0, L - d0)
    const v = d >= win ? base : base + (top - base) * 0.5 * (1 + Math.cos((Math.PI * d) / win))
    return [t, [v]] as [number, number[]]
  }).reduce<KF[]>((acc, [t, s], i, arr) => {
    acc.push(i === arr.length - 1 ? { t, s } : { t, s, ...ease })
    return acc
  }, [])
}

// ---------- door1: scan-line reading a glyph block ----------
function door1() {
  const L = 120
  const COLS = 16
  const ROWS = 5
  const x0 = 22
  const y0 = 40
  const px = 18
  const py = 24
  const barTop = y0 - 12
  const barBot = y0 + (ROWS - 1) * py + 12
  const cells = []
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const yc = y0 + r * py
    const peak = L * ((yc - barTop) / (barBot - barTop))
    cells.push(rectCell([12, 12], 2.5, GREEN, anim(pulseKeys(peak, L, 16, 14, 96)), [x0 + c * px, yc]))
  }
  const bar = {
    ty: 'gr',
    it: [
      { ty: 'rc', d: 1, p: stat([0, 0]), s: stat([COLS * px + 8, 3]), r: stat([1.5]) },
      { ty: 'fl', c: stat(GREEN), o: stat([100]) },
      {
        ty: 'tr',
        p: anim(keys([[0, [W / 2, barTop]], [L, [W / 2, barBot]]])),
        a: stat([0, 0]), s: stat([100, 100]), r: stat([0]),
        o: anim(keys([[0, [0]], [L * 0.16, [70]], [L * 0.84, [70]], [L, [0]]])),
      },
    ],
  }
  return write('door1.json', doc([layer('bar', [bar], L), layer('block', cells, L)], L))
}

// ---------- door2: terminal typing + blinking cursor ----------
function door2() {
  const L = 104
  const y = H / 2
  // a steady prompt block at the left, then the line types in beside it
  const prompt = rectCell([8, 22], 1.5, GREEN, stat([85]), [44, y])
  const N = 8
  const bx = 64
  const bpx = 23
  const cells = []
  for (let k = 0; k < N; k++) {
    const on = 6 + k * 5
    cells.push(rectCell([16, 22], 2.5, GREEN, anim(keys([[0, [0]], [on, [0]], [on + 1, [100]], [92, [100]], [99, [0]], [L, [0]]], true)), [bx + k * bpx, y]))
  }
  // cursor blinks while the line sits typed, then clears
  const cur = rectCell([16, 22], 2.5, GREEN, anim(keys([
    [0, [0]], [48, [0]], [49, [100]], [60, [100]], [61, [0]], [72, [0]], [73, [100]], [84, [100]], [85, [0]], [L, [0]],
  ], true)), [bx + N * bpx, y])
  return write('door2.json', doc([layer('term', [prompt, ...cells, cur], L)], L))
}

// ---------- door3: two identical byte-streams in lockstep (pack = unpack) ----------
function door3() {
  const L = 90
  const pitch = 30
  const heights = [10, 22, 14, 30, 12, 26, 16, 20, 28, 12, 24, 18, 14]
  // marquee position must be linear, not eased, or it stutters at the seam
  function trackLinear(yc: number) {
    const cells = heights.map((hgt, i) => rectCell([16, hgt], 2, GREEN, stat([78]), [i * pitch, 0]))
    const linear = [
      { t: 0, s: [-pitch, yc], i: { x: [1], y: [1] }, o: { x: [0], y: [0] } },
      { t: L, s: [0, yc] },
    ]
    return { ty: 'gr', it: [...cells, { ty: 'tr', p: { a: 1, k: linear }, a: stat([0, 0]), s: stat([100, 100]), r: stat([0]), o: stat([100]) }] }
  }
  return write('door3.json', doc([layer('streams', [trackLinear(66), trackLinear(122)], L)], L))
}

// ---------- door4: a cell broadcasting concentric rings ----------
function door4() {
  const L = 90
  const cx = W / 2
  const cy = H / 2
  function ring(delay: number) {
    return {
      ty: 'gr',
      it: [
        { ty: 'rc', d: 1, p: stat([0, 0]), s: stat([34, 34]), r: stat([5]) },
        { ty: 'st', c: stat(GREEN), o: stat([100]), w: stat([2.4]), lc: 2, lj: 2 },
        {
          ty: 'tr',
          p: stat([cx, cy]), a: stat([0, 0]), r: stat([0]),
          s: anim(keys([[0, [60, 60]], [delay, [60, 60]], [delay + 70, [520, 520]], [L, [520, 520]]])),
          o: anim(keys([[0, [0]], [delay, [85]], [delay + 70, [0]], [L, [0]]])),
        },
      ],
    }
  }
  const core = rectCell([20, 20], 5, GREEN, anim(keys([[0, [60]], [L / 2, [100]], [L, [60]]])), [cx, cy],
    anim(keys([[0, [88, 88]], [L / 2, [108, 108]], [L, [88, 88]]])))
  return write('door4.json', doc([layer('rings', [ring(0), ring(6), ring(12), core], L)], L))
}

console.log([door1(), door2(), door3(), door4()].join('\n'))
