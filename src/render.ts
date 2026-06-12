export function createRenderer(stage: HTMLElement) {
  let els: HTMLDivElement[] = []
  let prev: string[] = []
  return {
    render(rows: string[]): number {
      if (els.length !== rows.length) {
        stage.textContent = ''
        els = rows.map(() => stage.appendChild(document.createElement('div')))
        prev = []
      }
      let changed = 0
      for (let i = 0; i < rows.length; i++) {
        if (prev[i] !== rows[i]) {
          els[i].innerHTML = rows[i]
          changed++
        }
      }
      prev = rows.slice()
      return changed
    },
  }
}
