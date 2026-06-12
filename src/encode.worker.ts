// glyphcast band encoder worker: owns a horizontal band of the cell grid.
// Per frame it receives a cloned ImageBitmap of the video, samples its band
// via OffscreenCanvas, runs encodeCells, and transfers the fg/bg cell
// buffers back. Parallelizes BOTH sampling (getImageData) and encoding -
// the two serial costs that cap the single-threaded caster.
// NOT responsible for: band assembly, pack(), WS (cast.ts does those).
// Test strategy: E2E - worker-encoded cast must checksum-match the viewer.

import { encodeCells, sampleX, sampleY, type Mode } from './encode'

type InitMsg = { kind: 'init'; cols: number; rowsTotal: number; y0: number; y1: number; mode: Mode; qShift: number }
type FrameMsg = { kind: 'frame'; seq: number; bitmap: ImageBitmap }

let cfg: InitMsg | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

self.onmessage = (e: MessageEvent<InitMsg | FrameMsg>) => {
  const m = e.data
  if (m.kind === 'init') {
    cfg = m
    const canvas = new OffscreenCanvas(m.cols * sampleX(m.mode), (m.y1 - m.y0) * sampleY(m.mode))
    ctx = canvas.getContext('2d', { willReadFrequently: true })!
    return
  }
  if (!cfg || !ctx) {
    m.bitmap.close()
    return
  }
  const bandRows = cfg.y1 - cfg.y0
  const w = cfg.cols * sampleX(cfg.mode)
  const h = bandRows * sampleY(cfg.mode)
  const srcY = (cfg.y0 / cfg.rowsTotal) * m.bitmap.height
  const srcH = (bandRows / cfg.rowsTotal) * m.bitmap.height
  ctx.drawImage(m.bitmap, 0, srcY, m.bitmap.width, srcH, 0, 0, w, h)
  m.bitmap.close()
  const img = ctx.getImageData(0, 0, w, h)
  const n = cfg.cols * bandRows * 4
  const fg = new Uint8Array(n)
  const bg = new Uint8Array(n)
  encodeCells(img, cfg.cols, bandRows, cfg.mode, cfg.qShift, fg, bg)
  postMessage({ seq: m.seq, y0: cfg.y0, fg, bg }, { transfer: [fg.buffer, bg.buffer] })
}
