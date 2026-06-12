// glyphcast landing - "the site IS the codec". Boots the GL direct engine on a
// full-bleed cover-cropped canvas: bbb60.mp4 -> renderDirect (octant, in-shader
// encode, zero CPU per frame). Owns: cover layout math, autoplay kick,
// copy-frame-as-text proof, offscreen pause. NOT responsible for: encoding or
// rendering internals (encode.ts / renderer_gl.ts), the lab UI (main.ts).
// Test strategy: live browser smoke - hero animates, cells count fills in,
// copy button puts plain text on the clipboard, no console errors.

import { frameToPlainText, sampleX, sampleY } from './encode'
import { measureCharRatio, rowsFor } from './grid'
import { createRendererGL } from './renderer_gl'
import { createSampler } from './sampler'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const video = $<HTMLVideoElement>('video')
const canvas = $<HTMLCanvasElement>('hero-canvas')
const cellsEl = $('cells')
const tapPlay = $<HTMLButtonElement>('tapplay')
const copyBtn = $<HTMLButtonElement>('copyframe')

const CHAR_RATIO = measureCharRatio()
const MODE = 'octant'

const renderer = createRendererGL(canvas)
const sampler = createSampler()

let cols = 0
let rows = 0

function layout() {
  const vw = video.videoWidth || 16
  const vh = video.videoHeight || 9
  cols = innerWidth < 760 ? 420 : 960
  rows = rowsFor(cols, CHAR_RATIO, vw, vh)
  // cover-crop: size the canvas to the video aspect, overflowing the viewport
  // on one axis; #bg clips it
  const aspect = vw / vh
  let cw = innerWidth
  let ch = cw / aspect
  if (ch < innerHeight) {
    ch = innerHeight
    cw = ch * aspect
  }
  renderer.resize(cw, ch)
  cellsEl.textContent = (cols * rows).toLocaleString()
  redraw()
}

function redraw() {
  if (video.readyState >= 2) renderer.renderDirect(video, cols, rows, MODE, 0, 0)
}

function onVideoFrame() {
  redraw()
  video.requestVideoFrameCallback(onVideoFrame)
}

video.addEventListener('loadedmetadata', layout)
window.addEventListener('resize', layout)
layout()
video.requestVideoFrameCallback(onVideoFrame)

// the hero keeps compositing behind the solid sections; stop paying for video
// decode + texture upload once it's scrolled out of sight
let pausedOffscreen = false
new IntersectionObserver(([entry]) => {
  if (!entry.isIntersecting && !video.paused) {
    video.pause()
    pausedOffscreen = true
  } else if (entry.isIntersecting && pausedOffscreen) {
    pausedOffscreen = false
    void video.play()
  }
}).observe($('hero'))

// Brave (and strict Chrome profiles) block even muted autoplay; the autoplay
// attribute then fails silently. Retry a few times, then surface a real play
// affordance instead of a frozen black hero. (Same scar as main.ts.)
let kickTries = 0
const kick = setInterval(() => {
  if (!video.paused || pausedOffscreen) {
    clearInterval(kick)
    return
  }
  if (video.readyState < 2) return
  if (++kickTries > 5) {
    clearInterval(kick)
    tapPlay.hidden = false
    return
  }
  void video.play().catch(() => {})
}, 400)
tapPlay.addEventListener('click', () => void video.play())
// playback can also recover on its own after the kick gave up (Brave grants
// autoplay late on some profiles) - whatever started it, drop the affordance
video.addEventListener('play', () => (tapPlay.hidden = true))

// Vercel-style logo menu: right-click the logo for brand assets
const TEXT_LOGO = '▙▄\n███▄\n███▀\n▛▀'
const logo = $('logo')
const logoMenu = $('logomenu')

logo.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  logoMenu.hidden = false
  const w = logoMenu.offsetWidth
  const h = logoMenu.offsetHeight
  logoMenu.style.left = `${Math.min(e.clientX, innerWidth - w - 8)}px`
  logoMenu.style.top = `${Math.min(e.clientY, innerHeight - h - 8)}px`
})
window.addEventListener('pointerdown', (e) => {
  if (!logoMenu.contains(e.target as Node)) logoMenu.hidden = true
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') logoMenu.hidden = true
})

function copyFlash(btn: HTMLButtonElement, text: string) {
  void navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent
    btn.textContent = 'copied'
    setTimeout(() => {
      btn.textContent = orig
      logoMenu.hidden = true
    }, 700)
  })
}
$<HTMLButtonElement>('lm-copysvg').addEventListener('click', (e) => {
  e.stopPropagation()
  void fetch('/brand/glyphcast-mark.svg')
    .then((r) => r.text())
    .then((svg) => copyFlash($('lm-copysvg') as HTMLButtonElement, svg))
})
$<HTMLButtonElement>('lm-copytext').addEventListener('click', (e) => {
  e.stopPropagation()
  copyFlash($('lm-copytext') as HTMLButtonElement, TEXT_LOGO)
})

copyBtn.addEventListener('click', () => {
  if (video.readyState < 2) return
  const img = sampler.sample(video, cols * sampleX(MODE), rows * sampleY(MODE))
  void navigator.clipboard.writeText(frameToPlainText(img, cols, rows)).then(() => {
    const orig = copyBtn.textContent
    copyBtn.textContent = 'copied - paste it anywhere, it is text'
    setTimeout(() => (copyBtn.textContent = orig), 2400)
  })
})
