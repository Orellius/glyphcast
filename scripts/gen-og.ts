// Generates public/og.png - the 1200x630 social-share card. Built from the same
// play-triangle cell grammar as the brand mark (cell coords read from
// public/favicon.svg, scaled up) plus a faded glyph-cell field, so the share
// preview literally shows the codec. Emits an SVG to stdout-less temp then the
// caller rasterises with rsvg-convert. No exotic Unicode (rects + system fonts
// only) so it renders identically headless. Regenerate, never hand-edit og.png:
//   bun scripts/gen-og.ts > /tmp/og.svg && rsvg-convert ... (see npm script / README)

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SVG = readFileSync(resolve(ROOT, 'public/favicon.svg'), 'utf8')

const W = 1200
const H = 630
const GREEN = '#3ddc84'
const INK1 = '#e9ecf1'
const INK3 = '#6e7479'
const GREEN2 = '#6ee6a6'

type Rect = { x: number; y: number; w: number; h: number; op: number }
const rects: Rect[] = []
const re = /<rect[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"(?:[^>]*opacity="([\d.]+)")?/g
for (const m of SVG.matchAll(re)) {
  rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], op: m[5] ? +m[5] : 1 })
}

// --- the mark, scaled from the 80-unit favicon grid into a left-side block ---
const MARK = 248
const SCALE = MARK / 80
const RAD = 1.4 * SCALE
const mx = 96
const my = (H - MARK) / 2
const markCells = rects
  .map((r) => `<rect x="${(mx + r.x * SCALE).toFixed(1)}" y="${(my + r.y * SCALE).toFixed(1)}" width="${(r.w * SCALE).toFixed(1)}" height="${(r.h * SCALE).toFixed(1)}" rx="${RAD.toFixed(1)}" fill="${GREEN}" opacity="${r.op}"/>`)
  .join('')

// --- faded glyph-cell field bleeding off the top-right corner ---
const field: string[] = []
const FC = 7
const FR = 6
const fcell = 30
const fgap = 8
const fx0 = W - (FC * (fcell + fgap)) + 6
const fy0 = -18
for (let r = 0; r < FR; r++) {
  for (let c = 0; c < FC; c++) {
    const op = Math.max(0, 0.16 - (r * 0.018 + (FC - 1 - c) * 0.015))
    if (op <= 0.01) continue
    field.push(`<rect x="${fx0 + c * (fcell + fgap)}" y="${fy0 + r * (fcell + fgap)}" width="${fcell}" height="${fcell}" rx="4" fill="${GREEN}" opacity="${op.toFixed(3)}"/>`)
  }
}

const tx = mx + MARK + 56
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"
const MONO = "'Menlo', 'SF Mono', monospace"

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0a0a0c"/>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <defs><radialGradient id="g" cx="22%" cy="38%" r="80%">
    <stop offset="0%" stop-color="#0d1410"/><stop offset="100%" stop-color="#0a0a0c"/>
  </radialGradient></defs>
  ${field.join('')}
  ${markCells}
  <text x="${tx}" y="206" font-family="${MONO}" font-size="30" letter-spacing="1" fill="${INK1}">glyph<tspan fill="${GREEN2}">cast</tspan></text>
  <text x="${tx}" y="300" font-family="${SANS}" font-size="78" font-weight="700" letter-spacing="-2" fill="${INK1}">video as text.</text>
  <text x="${tx}" y="392" font-family="${SANS}" font-size="78" font-weight="700" letter-spacing="-2" fill="${GREEN2}">An AI can read it.</text>
  <rect x="${tx}" y="430" width="64" height="3" rx="1.5" fill="${GREEN}"/>
  <text x="${tx}" y="476" font-family="${MONO}" font-size="23" fill="${INK3}">a typography-only video codec  ·  glyphcast.tv</text>
</svg>`

const out = resolve(ROOT, 'public/og.svg')
writeFileSync(out, svg)
console.log(`wrote ${out} (${(svg.length / 1024).toFixed(1)}KB), rasterise to og.png next`)
