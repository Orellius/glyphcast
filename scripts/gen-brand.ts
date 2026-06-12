// Brand asset generator. The glyphcast mark is a play triangle rasterized to
// quadrant cells (2x2 subpixels) - same grammar as the codec. This script is
// the source of truth: it computes the cell masks and emits every SVG + the
// text logo into public/brand/ and public/favicon.svg. Regenerate with
// `bun scripts/gen-brand.ts`; never hand-edit the outputs.
// NOT responsible for: the brand page markup (public/brand/index.html).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ACCENT = '#3ddc84'
const ACCENT_LIGHT_BG = '#16a34a'

const COLS = 5
const ROWS = 4
const shape = (x: number, y: number) => x <= 0.96 * (1 - Math.abs(2 * y - 1))

function raster(): number[][] {
  const cells: number[][] = []
  for (let cy = 0; cy < ROWS; cy++) {
    const row: number[] = []
    for (let cx = 0; cx < COLS; cx++) {
      let mask = 0
      const sub: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]]
      sub.forEach(([sx, sy], i) => {
        const x = (cx * 2 + sx + 0.5) / (COLS * 2)
        const y = (cy * 2 + sy + 0.5) / (ROWS * 2)
        if (shape(x, y)) mask |= 1 << i
      })
      row.push(mask)
    }
    cells.push(row)
  }
  // trim fully-empty trailing columns so the mark viewBox is tight
  while (cells.every((r) => r[r.length - 1] === 0)) cells.forEach((r) => r.pop())
  return cells
}

const QUAD = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']
const bits = (m: number) => [m & 1, m & 2, m & 4, m & 8].filter(Boolean).length

function markSvg(cells: number[][], color: string): string {
  const W = cells[0].length * 2 * 10
  const H = cells.length * 2 * 10
  let rects = ''
  cells.forEach((row, cy) =>
    row.forEach((mask, cx) => {
      if (!mask) return
      const op = mask === 15 ? 1 : +(0.55 + bits(mask) * 0.08).toFixed(2)
      const sub: Array<[number, number, number]> = [[0, 0, 1], [1, 0, 2], [0, 1, 4], [1, 1, 8]]
      for (const [sx, sy, b] of sub) {
        if (!(mask & b)) continue
        const x = (cx * 2 + sx) * 10 + 0.8
        const y = (cy * 2 + sy) * 10 + 0.8
        rects += `<rect x="${x}" y="${y}" width="8.4" height="8.4" rx="1.4" fill="${color}"${op < 1 ? ` opacity="${op}"` : ''}/>`
      }
    }),
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${rects}</svg>`
}

function lockupSvg(cells: number[][], markColor: string, textColor: string): string {
  const markW = cells[0].length * 2 * 10
  const H = cells.length * 2 * 10
  const mark = markSvg(cells, markColor).replace(/<\/?svg[^>]*>/g, '')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${markW + 320} ${H}">` +
    `<g>${mark}</g>` +
    `<text x="${markW + 18}" y="${H / 2}" dominant-baseline="central" ` +
    `font-family="ui-monospace, Menlo, Consolas, monospace" font-size="52" font-weight="700" ` +
    `letter-spacing="1" fill="${textColor}">glyph<tspan fill="${markColor}">cast</tspan></text></svg>`
  )
}

const cells = raster()
const textLogo = cells.map((r) => r.map((m) => QUAD[m]).join('')).join('\n')

const outDir = join(import.meta.dirname, '..', 'public', 'brand')
mkdirSync(outDir, { recursive: true })

writeFileSync(join(outDir, 'glyphcast-mark.svg'), markSvg(cells, ACCENT))
writeFileSync(join(outDir, 'glyphcast-mark-light-bg.svg'), markSvg(cells, ACCENT_LIGHT_BG))
writeFileSync(join(outDir, 'glyphcast-mark-mono.svg'), markSvg(cells, 'currentColor'))
writeFileSync(join(outDir, 'glyphcast-lockup.svg'), lockupSvg(cells, ACCENT, '#e7e7ec'))
writeFileSync(join(outDir, 'glyphcast-lockup-light-bg.svg'), lockupSvg(cells, ACCENT_LIGHT_BG, '#1b1b1f'))
writeFileSync(join(outDir, 'glyphcast-logo.txt'), textLogo + '\n')
writeFileSync(join(outDir, '..', 'favicon.svg'), markSvg(cells, ACCENT))

console.log('mark grid (' + cells[0].length + 'x' + cells.length + ' cells):')
console.log(textLogo)
console.log('\nwrote 6 assets to public/brand/ + public/favicon.svg')
