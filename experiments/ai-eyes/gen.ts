// AI-eyes benchmark, stage 1: generate text-encoded frames. For each ground-
// truth timestamp x variant (mode x cols), decode the frame via ffmpeg to raw
// RGBA, run the real codec (src/encode.ts), and emit the text an LLM would
// receive. Deterministic; writes to experiments/ai-eyes/variants/.
// NOT responsible for: API calls (bench.ts), scoring, ground truth (answers.json).
// Run: bun experiments/ai-eyes/gen.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GLYPH_CHARS, encodeCells, frameToPlainText, sampleX, sampleY, type Mode } from '../../src/encode'

const CLIP = join(import.meta.dirname, '..', '..', 'public', 'bbb60.mp4')
const OUT = join(import.meta.dirname, 'variants')
const TIMES = [2, 7, 12, 17, 22, 27]
const CHAR_RATIO = 0.6 // Menlo-class cell aspect; matches grid.ts measurement
const ASPECT = 9 / 16

function rawFrame(t: number, w: number, h: number): ImageData {
  const p = Bun.spawnSync([
    'ffmpeg', '-v', 'error', '-ss', String(t), '-i', CLIP, '-frames:v', '1',
    '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ])
  if (p.exitCode !== 0 || p.stdout.length !== w * h * 4) {
    throw new Error(`ffmpeg failed for t=${t} ${w}x${h}: got ${p.stdout.length} bytes`)
  }
  return { data: new Uint8ClampedArray(p.stdout), width: w, height: h, colorSpace: 'srgb' } as ImageData
}

const rowsFor = (cols: number) => Math.max(1, Math.round(cols * CHAR_RATIO * ASPECT))

function glyphText(img: ImageData, cols: number, rows: number, mode: Mode): string {
  const n = cols * rows * 4
  const fg = new Uint8Array(n)
  const bg = new Uint8Array(n)
  encodeCells(img, cols, rows, mode, 0, fg, bg)
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      const g = fg[(y * cols + x) * 4 + 3]
      line += g === 255 ? ' ' : (GLYPH_CHARS[g] ?? ' ')
    }
    lines.push(line)
  }
  return lines.join('\n')
}

function ansiText(img: ImageData, cols: number, rows: number, mode: Mode): string {
  const n = cols * rows * 4
  const fg = new Uint8Array(n)
  const bg = new Uint8Array(n)
  encodeCells(img, cols, rows, mode, 0, fg, bg)
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    let lf = '', lb = ''
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4
      const g = fg[i + 3]
      const f = `${fg[i]};${fg[i + 1]};${fg[i + 2]}`
      const b = `${bg[i]};${bg[i + 1]};${bg[i + 2]}`
      if (f !== lf) { line += `\x1b[38;2;${f}m`; lf = f }
      if (b !== lb) { line += `\x1b[48;2;${b}m`; lb = b }
      line += g === 255 ? ' ' : (GLYPH_CHARS[g] ?? ' ')
    }
    lines.push(line + '\x1b[0m')
  }
  return lines.join('\n')
}

mkdirSync(OUT, { recursive: true })
const index: Array<{ t: number; variant: string; file: string; chars: number; bytes: number }> = []

for (const t of TIMES) {
  for (const mode of ['ascii', 'quadrant', 'halfblock'] as const) {
    for (const cols of [40, 80, 120]) {
      const rows = rowsFor(cols)
      const img = rawFrame(t, cols * sampleX(mode), rows * sampleY(mode))
      const text = mode === 'ascii' ? frameToPlainText(img, cols, rows) : glyphText(img, cols, rows, mode)
      const name = `t${t}-${mode}-${cols}.txt`
      writeFileSync(join(OUT, name), text)
      index.push({ t, variant: `${mode}-${cols}`, file: name, chars: text.length, bytes: Buffer.byteLength(text) })
    }
  }
  // one color arm: ANSI truecolor quadrant 80 (what a terminal-bound agent would pipe in)
  const cols = 80
  const rows = rowsFor(cols)
  const img = rawFrame(t, cols * sampleX('quadrant'), rows * sampleY('quadrant'))
  const text = ansiText(img, cols, rows, 'quadrant')
  const name = `t${t}-ansi-80.txt`
  writeFileSync(join(OUT, name), text)
  index.push({ t, variant: 'ansi-80', file: name, chars: text.length, bytes: Buffer.byteLength(text) })
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2))
console.log(`${index.length} variants written; bytes min/max: ${Math.min(...index.map((i) => i.bytes))}/${Math.max(...index.map((i) => i.bytes))}`)
