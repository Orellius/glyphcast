// shared grid math: char cell aspect measured from the real font, and the
// rows count that keeps video aspect at a given cols. Used by main + cast + view.

export const FONT = 'Menlo, Consolas, monospace'

export function measureCharRatio(): number {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = `100px ${FONT}`
  return ctx.measureText('▀').width / 100
}

export function rowsFor(cols: number, charRatio: number, vw: number, vh: number): number {
  return Math.max(1, Math.round(cols * charRatio * (vh / vw)))
}
