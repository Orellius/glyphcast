// Lab chrome layer. main.ts owns the encoder + the window.__gc debug API and
// wires the native <select>/<input> controls by id; this module is the visible
// UI on top: segmented engine/glyph controls and preset chips that drive those
// hidden natives, live slider value labels, a viewport badge, and the two proof
// benches (__gc.benchWire / __gc.benchGl) surfaced as buttons with readouts.
// Loads AFTER main.ts so window.__gc exists. NOT responsible for: encoding,
// rendering, or the per-frame stats line (main.ts owns #stats).

const $ = (id: string) => document.getElementById(id)

// segmented buttons drive the hidden <select> main.ts listens to
for (const seg of document.querySelectorAll<HTMLElement>('.seg[data-for]')) {
  const sel = $(seg.dataset.for!) as HTMLSelectElement
  seg.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn) return
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b === btn)
    sel.value = btn.dataset.v!
    sel.dispatchEvent(new Event('change'))
    updateBadge()
  })
}

// preset chips set cols, clamped to the slider's current max (dom caps at 320)
const colsSlider = $('cols') as HTMLInputElement
for (const chip of document.querySelectorAll<HTMLElement>('#presets .chip')) {
  chip.addEventListener('click', () => {
    const v = Math.min(Number(chip.dataset.cols), Number(colsSlider.max))
    colsSlider.value = String(v)
    colsSlider.dispatchEvent(new Event('input'))
  })
}

// live value labels next to the raw sliders
for (const [id, vid] of [['quant', 'quantv'], ['sharp', 'sharpv'], ['glow', 'glowv']] as const) {
  const r = $(id) as HTMLInputElement
  const v = $(vid) as HTMLSpanElement
  r.addEventListener('input', () => (v.textContent = r.value))
}

function updateBadge() {
  const g = window.__gc?.grid()
  if (!g) return
  $('badge')!.innerHTML =
    g.engine === 'gpu' ? 'gpu shader · <b>0ms CPU</b>' : `dom text · <b>cpu encode</b>`
}
updateBadge()

// ---------- proof benches ----------
const out = $('benchOut') as HTMLElement
async function withBusy(btn: HTMLButtonElement, label: string, run: () => Promise<string> | string) {
  const orig = btn.textContent
  btn.disabled = true
  btn.textContent = 'running…'
  out.textContent = `${label}…`
  try {
    out.innerHTML = await run()
  } catch (err) {
    out.textContent = `bench failed: ${(err as Error).message}`
  } finally {
    btn.disabled = false
    btn.textContent = orig
  }
}

;($('benchWire') as HTMLButtonElement).addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement
  const g = window.__gc.grid()
  // dom-engine cols clamp keeps this honest; benchWire seeks real frames
  const cols = Math.min(g.cols, 960)
  void withBusy(btn, 'seeking 12 frames + packing', async () => {
    const r = await window.__gc.benchWire({ frames: 12, cols, mode: g.mode, wireMode: 'color', fps: 24 })
    const ok = r.roundtripOk ? '<b>lossless ✓</b>' : 'ROUNDTRIP MISMATCH'
    return (
      `${cols}×${Math.round(r.cells / cols)} ${g.mode} · color · 24fps\n` +
      `key frame      <b>${(r.keyBytes / 1024).toFixed(1)} KB</b>\n` +
      `avg delta      <b>${r.avgDeltaBytes} B</b>/frame\n` +
      `raw bitrate    <b>${r.rawKbps} kbps</b>\n` +
      `deflated       <b>${r.deflateKbps} kbps</b>\n` +
      `pack→unpack    ${ok}`
    )
  })
})

;($('benchEnc') as HTMLButtonElement).addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement
  const g = window.__gc.grid()
  void withBusy(btn, 'timing 120 gpu encodes', () => {
    const r = window.__gc.benchGl(120)
    return (
      `gpu direct encode · ${g.cols}×${Math.round((g.rows))} ${g.mode}\n` +
      `${r.iters} frames in <b>${r.totalMs.toFixed(0)} ms</b>\n` +
      `per frame      <b>${r.msPerFrame.toFixed(2)} ms</b>\n` +
      `ceiling        <b>${Math.round(r.maxFps)} fps</b>`
    )
  })
})
