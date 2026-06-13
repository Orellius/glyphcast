// Builds a palette-quantised, LLM-readable text rendering of a video frame: a
// legend mapping letters to hex colours + coarse colour names, then a grid of
// those letters. A text-only model reconstructs the scene from the named palette
// and the spatial layout of colour regions - far more signal than a luminance
// ramp, and the colour frame is what the 83% blind benchmark was measured on.
// Public surface: frameToColorText(img, cols, rows). NOT responsible for:
// sampling (sampler.ts), the codec wire (wire.ts), or display rendering.
// Test strategy: paste the output into an LLM and confirm it names the scene.

const LETTERS = 'ABCDEFGHIJKLMNOP'

// coarse colour anchors so the legend reads in words, not just hex
const NAMED: [string, number, number, number][] = [
  ['black', 18, 18, 20], ['dark grey', 70, 70, 75], ['grey', 140, 140, 145], ['white', 235, 235, 238],
  ['red', 200, 45, 45], ['orange', 220, 130, 45], ['yellow', 225, 210, 80],
  ['olive', 130, 140, 60], ['green', 80, 160, 65], ['forest green', 40, 95, 45],
  ['teal', 60, 150, 150], ['sky blue', 150, 195, 228], ['blue', 60, 110, 205],
  ['purple', 130, 70, 165], ['magenta', 205, 70, 170], ['pink', 224, 158, 185],
  ['brown', 120, 80, 50], ['tan', 205, 180, 135], ['cream', 225, 215, 185],
]

function nearestName(r: number, g: number, b: number): string {
  let best = NAMED[0][0]
  let bd = Infinity
  for (const [name, nr, ng, nb] of NAMED) {
    const dd = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2
    if (dd < bd) { bd = dd; best = name }
  }
  return best
}
const hex2 = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')
const hex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`

export function frameToColorText(img: ImageData, cols: number, rows: number, paletteSize = 12): string {
  const d = img.data
  const W = img.width
  const sx = (W / cols) | 0
  const sy = (img.height / rows) | 0
  const n = sx * sy || 1

  // average colour per cell
  const cellRGB = new Array<[number, number, number]>(cols * rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let r = 0, g = 0, b = 0
      for (let dy = 0; dy < sy; dy++) {
        for (let dx = 0; dx < sx; dx++) {
          const i = ((y * sy + dy) * W + x * sx + dx) * 4
          r += d[i]; g += d[i + 1]; b += d[i + 2]
        }
      }
      cellRGB[y * cols + x] = [(r / n) | 0, (g / n) | 0, (b / n) | 0]
    }
  }

  // build a palette: bucket to 4 bits/channel, keep the most populated buckets,
  // representative = the average colour of each bucket's members
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (const [r, g, b] of cellRGB) {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const e = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    e.count++; e.r += r; e.g += g; e.b += b
    buckets.set(key, e)
  }
  // most-populous bucket colours first, then greedily keep only ones that are
  // mutually distinct so the limited palette spends its slots on real variety
  const ranked = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => [(e.r / e.count) | 0, (e.g / e.count) | 0, (e.b / e.count) | 0] as [number, number, number])
  const K = Math.min(paletteSize, LETTERS.length)
  const MIN_DIST2 = 30 * 30
  const palette: [number, number, number][] = []
  for (const c of ranked) {
    if (palette.length >= K) break
    if (palette.every((p) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2 > MIN_DIST2)) palette.push(c)
  }
  if (palette.length === 0 && ranked.length) palette.push(ranked[0])

  // assign each cell to the nearest palette entry
  const idxOf = (r: number, g: number, b: number) => {
    let bi = 0, bd = Infinity
    for (let p = 0; p < palette.length; p++) {
      const [pr, pg, pb] = palette[p]
      const dd = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
      if (dd < bd) { bd = dd; bi = p }
    }
    return bi
  }

  const legend = palette
    .map(([r, g, b], i) => `${LETTERS[i]} = ${hex(r, g, b)} (${nearestName(r, g, b)})`)
    .join('\n')

  let grid = ''
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      const [r, g, b] = cellRGB[y * cols + x]
      line += LETTERS[idxOf(r, g, b)]
    }
    grid += line + '\n'
  }

  return `palette:\n${legend}\n\ngrid (${cols}x${rows}, each letter is that colour):\n${grid.trimEnd()}`
}
