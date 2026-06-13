// AI-eyes benchmark, local arm: same protocol as bench.ts but against Ollama
// (no key, $0). Sequential per model to avoid reload thrash; grid trimmed to
// cols 40/80 and no ANSI variant (local prompt-eval cost). Vision arm is
// attempted once per model and skipped if the model lacks image support.
// Pre-registered bars are shared with bench.ts (task #9).
// Run: bun experiments/ai-eyes/bench-local.ts
// NOT responsible for: variant generation (gen.ts), ground truth (answers.json).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = import.meta.dirname
const VAR = join(DIR, 'variants')
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const MODELS = ['gemma4:31b', 'devstral-small-2:latest', 'gemma4-research:12b-bf16']
const HARD = process.argv.includes('--hard')

const answers = JSON.parse(readFileSync(join(DIR, 'answers.json'), 'utf8'))
const index: Array<{ t: number; variant: string; file: string }> = JSON.parse(
  readFileSync(join(VAR, 'index.json'), 'utf8'),
)
const grid = index.filter((v) => !v.variant.endsWith('-120') && !v.variant.startsWith('ansi'))

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
  ascii: 'an ASCII luminance ramp - each character is one pixel, denser characters ("@#%") are brighter, spaces/dots are darker',
  quadrant: 'Unicode quadrant block characters - each character is a 2x2 subpixel mask (e.g. ▘▀▟█), shape encodes which quadrants of the cell are lit',
  halfblock: 'Unicode half-block characters - each character encodes a 1x2 vertical pixel pair',
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

type ChatResp = { message?: { content?: string }; prompt_eval_count?: number; error?: string }
async function chat(model: string, content: string, images?: string[]): Promise<{ text: string; inTok: number }> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    // cold bf16 prompt-eval can run minutes; bun's default fetch timeout is shorter
    signal: AbortSignal.timeout(900_000),
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0, num_ctx: 8192 },
      messages: [{ role: 'user', content, ...(images ? { images } : {}) }],
    }),
  })
  const j = (await res.json()) as ChatResp
  if (j.error) throw new Error(`${model}: ${j.error}`)
  return { text: j.message?.content ?? '', inTok: j.prompt_eval_count ?? 0 }
}

type Row = {
  model: string; t: number; variant: string; correct: boolean; picked: string
  expected: string; inTok: number; seen: string
}
const results: Row[] = []
const t0 = Date.now()

for (const model of MODELS) {
  console.log(`=== ${model} ===`)
  // probe vision support once
  let vision = true
  const probePng = Bun.spawnSync(['ffmpeg', '-v', 'error', '-ss', '2', '-i',
    join(DIR, '..', '..', 'public', 'bbb60.mp4'), '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', '-'])
  const probeB64 = Buffer.from(probePng.stdout).toString('base64')
  try {
    await chat(model, 'One word: what animal is in this image?', [probeB64])
  } catch {
    vision = false
    console.log(`  (no image support - skipping vision arm)`)
  }

  for (const fr of answers.frames) {
    const opts: string[] = HARD ? fr.hardOptions : fr.options
    for (const v of grid.filter((g) => g.t === fr.t)) {
      const text = readFileSync(join(VAR, v.file), 'utf8')
      const seed = fr.t * 1000 + v.variant.length * 7 + model.length
      const shuf = shuffled(opts, seed)
      const expected = 'ABCD'[shuf.indexOf(opts[0])]
      try {
        const { text: out, inTok } = await chat(model, prompt(text, v.variant, shuf))
        const picked = /ANSWER:\s*([A-D])/i.exec(out)?.[1]?.toUpperCase() ?? '?'
        const seen = /SEEN:\s*(.+)/i.exec(out)?.[1]?.trim() ?? ''
        results.push({ model, t: fr.t, variant: v.variant, correct: picked === expected, picked, expected, inTok, seen })
        console.log(`  t${fr.t} ${v.variant}: ${picked === expected ? 'OK' : `wrong (${picked} vs ${expected})`} [${inTok} tok]`)
      } catch (e) {
        results.push({ model, t: fr.t, variant: v.variant, correct: false, picked: 'ERR', expected, inTok: 0, seen: String(e).slice(0, 80) })
        console.log(`  t${fr.t} ${v.variant}: ERROR ${String(e).slice(0, 80)}`)
      }
    }
    if (vision) {
      const png = Bun.spawnSync(['ffmpeg', '-v', 'error', '-ss', String(fr.t), '-i',
        join(DIR, '..', '..', 'public', 'bbb60.mp4'), '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', '-'])
      const shuf = shuffled(opts, fr.t * 31 + model.length)
      const expected = 'ABCD'[shuf.indexOf(opts[0])]
      const q = `Which of these best describes the image?\n` +
        shuf.map((o, i) => `${'ABCD'[i]}. ${o}`).join('\n') +
        `\n\nReply with exactly:\nANSWER: <letter>\nSEEN: <one short sentence>`
      const { text: out, inTok } = await chat(model, q, [Buffer.from(png.stdout).toString('base64')])
      const picked = /ANSWER:\s*([A-D])/i.exec(out)?.[1]?.toUpperCase() ?? '?'
      const seen = /SEEN:\s*(.+)/i.exec(out)?.[1]?.trim() ?? ''
      results.push({ model, t: fr.t, variant: 'vision-png', correct: picked === expected, picked, expected, inTok, seen })
      console.log(`  t${fr.t} vision: ${picked === expected ? 'OK' : `wrong (${picked} vs ${expected})`} [${inTok} tok]`)
    }
  }
}

mkdirSync(join(DIR, 'results'), { recursive: true })
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
const tag = `local-${stamp}${HARD ? '-hard' : ''}`
writeFileSync(join(DIR, 'results', `run-${tag}.json`), JSON.stringify(results, null, 1))

const variants = [...new Set(results.map((r) => r.variant))].sort()
let md = `# AI-eyes local run ${stamp} (${HARD ? 'hard' : 'easy'} options, Ollama, temp 0)\n\n| variant | ${MODELS.join(' | ')} | mean inTok |\n|---|${MODELS.map(() => '---').join('|')}|---|\n`
for (const v of variants) {
  const rows = results.filter((r) => r.variant === v)
  const cells = MODELS.map((m) => {
    const mr = rows.filter((r) => r.model === m)
    return mr.length ? `${Math.round((100 * mr.filter((r) => r.correct).length) / mr.length)}%` : '-'
  })
  const tok = Math.round(rows.reduce((s, r) => s + r.inTok, 0) / Math.max(1, rows.length))
  md += `| ${v} | ${cells.join(' | ')} | ${tok} |\n`
}
md += `\nchance = 25% · ${results.length} calls · ${Math.round((Date.now() - t0) / 60000)} min\n`
writeFileSync(join(DIR, 'results', `summary-${tag}.md`), md)
console.log(md)
