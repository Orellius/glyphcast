export function createSampler(p3 = false) {
  const canvas = document.createElement('canvas')
  const opts: CanvasRenderingContext2DSettings = { willReadFrequently: true }
  if (p3) opts.colorSpace = 'display-p3'
  const ctx = canvas.getContext('2d', opts)!
  return {
    sample(video: HTMLVideoElement, cols: number, pxRows: number): ImageData {
      if (canvas.width !== cols) canvas.width = cols
      if (canvas.height !== pxRows) canvas.height = pxRows
      ctx.drawImage(video, 0, 0, cols, pxRows)
      return ctx.getImageData(0, 0, cols, pxRows, p3 ? { colorSpace: 'display-p3' } : undefined)
    },
  }
}
