// AI-eyes: generate a COLOR representation of each frame for the legibility
// test. The earlier variants were mono (shape only); this adds the codec's
// defining signal. Output per frame: a shape grid (glyphs) + an aligned color
// grid (8-color palette letters per cell), both 24x12. Compact and parseable -
// no 127KB of ANSI escape noise. Run: bun experiments/ai-eyes/gen-color.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GLYPH_CHARS, encodeCells, sampleX, sampleY } from '../../src/encode'

const CLIP = join(import.meta.dirname, '..', '..', 'public', 'bbb60.mp4')
const OUT = join(import.meta.dirname, 'color-variants')
const TIMES = [2, 7, 12, 17, 22, 27]
const COLS = 24
const ROWS = 12

// 8 ANSI-ish anchors -> single letters
const PAL: Array<[string, [number, number, number]]> = [
  ['K', [10, 10, 12]], ['w', [120, 120, 128]], ['W', [235, 235, 240]],
  ['R', [200, 60, 50]], ['G', [80, 170, 80]], ['Y', [210, 180, 90]],
  ['B', [70, 110, 200]], ['C', [120, 200, 210]], ['M', [180, 90, 160]],
]
function palLetter(r: number, g: number, b: number): string {
  let best = 'K'
  let bd = Infinity
  for (const [ch, [pr, pg, pb]] of PAL) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
    if (d < bd) {
      bd = d
      best = ch
    }
  }
  return best
}

function rawFrame(t: number, w: number, h: number): ImageData {
  const p = Bun.spawnSync(['ffmpeg', '-v', 'error', '-ss', String(t), '-i', CLIP, '-frames:v', '1',
    '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
  return { data: new Uint8ClampedArray(p.stdout), width: w, height: h, colorSpace: 'srgb' } as ImageData
}

mkdirSync(OUT, { recursive: true })
const fg = new Uint8Array(COLS * ROWS * 4)
const bg = new Uint8Array(COLS * ROWS * 4)

for (const t of TIMES) {
  const img = rawFrame(t, COLS * sampleX('quadrant'), ROWS * sampleY('quadrant'))
  encodeCells(img, COLS, ROWS, 'quadrant', 0, fg, bg)
  const shape: string[] = []
  const color: string[] = []
  for (let r = 0; r < ROWS; r++) {
    let sl = ''
    let cl = ''
    for (let c = 0; c < COLS; c++) {
      const i = (r * COLS + c) * 4
      sl += GLYPH_CHARS[fg[i + 3]] ?? ' '
      cl += palLetter(fg[i], fg[i + 1], fg[i + 2])
    }
    shape.push(sl)
    color.push(cl)
  }
  const doc =
    `SHAPE LAYER (Unicode quadrant glyphs, ${COLS}x${ROWS}, filled quadrants = foreground):\n` +
    shape.join('\n') +
    `\n\nCOLOR LAYER (dominant color of each cell, same ${COLS}x${ROWS} grid)\n` +
    `K=near-black w=grey W=white R=red G=green Y=yellow/tan B=blue C=cyan M=magenta:\n` +
    color.join('\n') + '\n'
  writeFileSync(join(OUT, `t${t}.txt`), doc)
}
console.log(`wrote ${TIMES.length} color-rep frames to color-variants/`)
