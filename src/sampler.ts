export function createSampler() {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return {
    sample(video: HTMLVideoElement, cols: number, pxRows: number): ImageData {
      if (canvas.width !== cols) canvas.width = cols
      if (canvas.height !== pxRows) canvas.height = pxRows
      ctx.drawImage(video, 0, 0, cols, pxRows)
      return ctx.getImageData(0, 0, cols, pxRows)
    },
  }
}
