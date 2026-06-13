// AI-eyes benchmark, stage 2: the measurement. For each model x frame x text
// variant, ask a shuffled 4-way multiple choice ("which describes the image
// encoded above?") and record accuracy + token usage. A vision arm sends the
// same frames as PNGs for the ceiling + the token-cost baseline. Writes
// results/<run>.json + summary.md. Pre-registered bars (see task #9):
// pivot-worthy = >=80% recognition at <=2x vision tokens; kill = nothing >50%.
// NOT responsible for: variant generation (gen.ts), ground truth (answers.json).
// Run: ~/.claude/scripts/with-env ~/.env.local bun experiments/ai-eyes/bench.ts [--hard]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = import.meta.dirname
const VAR = join(DIR, 'variants')
const KEY = process.env.ANTHROPIC_API_KEY
if (!KEY) {
  console.error('ANTHROPIC_API_KEY missing - run through with-env')
  process.exit(1)
}

const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-fable-5']
const HARD = process.argv.includes('--hard')
const answers = JSON.parse(readFileSync(join(DIR, 'answers.json'), 'utf8'))
const index: Array<{ t: number; variant: string; file: string }> = JSON.parse(
  readFileSync(join(VAR, 'index.json'), 'utf8'),
)

// deterministic shuffle so runs are reproducible
function shuffled<T>(arr: T[], seed: number): T[] {
  const a = [...arr]
  let s = seed
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const ENCODING_NOTE: Record<string, string> = {
  ascii:
    'an ASCII luminance ramp (dark " .:-=+*#%@" bright is reversed: "@" darkest, " " brightest may vary) - each character is one pixel of brightness',
  quadrant:
    'Unicode quadrant block characters - each character is a 2x2 subpixel mask (e.g. ▘▀▟█), shape encodes which quadrants of the cell are foreground',
  halfblock:
    'Unicode half-block characters - each character encodes a 1x2 vertical pixel pair',
  ansi: 'ANSI truecolor escape sequences with quadrant block characters - colors carry the image, as a terminal would render it',
}

function prompt(text: string, variant: string, options: string[]): string {
  const kind = variant.split('-')[0]
  return (
    `The block below is a single video frame encoded as text: ${ENCODING_NOTE[kind]}.\n` +
    `Mentally reconstruct the image and answer.\n\n` +
    '```\n' + text + '\n```\n\n' +
    `Which of these best describes the image?\n` +
    options.map((o, i) => `${'ABCD'[i]}. ${o}`).join('\n') +
    `\n\nReply with exactly:\nANSWER: <letter>\nSEEN: <one short sentence describing what you can actually make out>`
  )
}

type Content = Array<Record<string, unknown>>
async function call(model: string, content: Content): Promise<{ text: string; inTok: number }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content }] }),
    })
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    const j = (await res.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number }; error?: { message?: string } }
    if (j.error) throw new Error(`${model}: ${j.error.message}`)
    return { text: j.content?.map((c) => c.text ?? '').join('') ?? '', inTok: j.usage?.input_tokens ?? 0 }
  }
  throw new Error(`${model}: retries exhausted`)
}

type Row = {
  model: string; t: number; variant: string; correct: boolean; picked: string
  expected: string; inTok: number; seen: string
}

const results: Row[] = []
const queue: Array<() => Promise<void>> = []

for (const model of MODELS) {
  for (const fr of answers.frames) {
    const opts: string[] = HARD ? fr.hardOptions : fr.options
    for (const v of index.filter((i) => i.t === fr.t)) {
      queue.push(async () => {
        const text = readFileSync(join(VAR, v.file), 'utf8')
        const seed = fr.t * 1000 + v.variant.length * 7 + model.length
        const shuf = shuffled(opts, seed)
        const expected = 'ABCD'[shuf.indexOf(opts[0])]
        const { text: out, inTok } = await call(model, [{ type: 'text', text: prompt(text, v.variant, shuf) }])
        const picked = /ANSWER:\s*([A-D])/i.exec(out)?.[1]?.toUpperCase() ?? '?'
        const seen = /SEEN:\s*(.+)/i.exec(out)?.[1]?.trim() ?? ''
        results.push({ model, t: fr.t, variant: v.variant, correct: picked === expected, picked, expected, inTok, seen })
      })
    }
    // vision ceiling arm: the same frame as a PNG
    queue.push(async () => {
      const png = Bun.spawnSync(['ffmpeg', '-v', 'error', '-ss', String(fr.t), '-i',
        join(DIR, '..', '..', 'public', 'bbb60.mp4'), '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', '-'])
      const b64 = Buffer.from(png.stdout).toString('base64')
      const shuf = shuffled(opts, fr.t * 31 + model.length)
      const expected = 'ABCD'[shuf.indexOf(opts[0])]
      const q = `Which of these best describes the image?\n` +
        shuf.map((o: string, i: number) => `${'ABCD'[i]}. ${o}`).join('\n') +
        `\n\nReply with exactly:\nANSWER: <letter>\nSEEN: <one short sentence>`
      const { text: out, inTok } = await call(model, [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: q },
      ])
      const picked = /ANSWER:\s*([A-D])/i.exec(out)?.[1]?.toUpperCase() ?? '?'
      const seen = /SEEN:\s*(.+)/i.exec(out)?.[1]?.trim() ?? ''
      results.push({ model, t: fr.t, variant: 'vision-png', correct: picked === expected, picked, expected, inTok, seen })
    })
  }
}

console.log(`${queue.length} calls queued (${HARD ? 'hard' : 'easy'} arm)...`)
const POOL = 4
let done = 0
await Promise.all(
  Array.from({ length: POOL }, async () => {
    while (queue.length) {
      const job = queue.shift()!
      await job()
      if (++done % 20 === 0) console.log(`${done} done`)
    }
  }),
)

mkdirSync(join(DIR, 'results'), { recursive: true })
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
writeFileSync(join(DIR, 'results', `run-${stamp}${HARD ? '-hard' : ''}.json`), JSON.stringify(results, null, 1))

// summary: accuracy + mean input tokens per model x variant
const variants = [...new Set(results.map((r) => r.variant))].sort()
let md = `# AI-eyes run ${stamp} (${HARD ? 'hard' : 'easy'} options)\n\n| variant | ${MODELS.join(' | ')} | mean inTok |\n|---|${MODELS.map(() => '---').join('|')}|---|\n`
for (const v of variants) {
  const rows = results.filter((r) => r.variant === v)
  const cells = MODELS.map((m) => {
    const mr = rows.filter((r) => r.model === m)
    return mr.length ? `${Math.round((100 * mr.filter((r) => r.correct).length) / mr.length)}%` : '-'
  })
  const tok = Math.round(rows.reduce((s, r) => s + r.inTok, 0) / rows.length)
  md += `| ${v} | ${cells.join(' | ')} | ${tok} |\n`
}
writeFileSync(join(DIR, 'results', `summary-${stamp}${HARD ? '-hard' : ''}.md`), md)
console.log(md)
