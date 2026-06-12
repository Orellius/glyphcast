// Multi-page build: all four surfaces ship. public/ is copied wholesale by
// vite, so the build script must prune local-only clips (demo*.mp4,
// sample.mp4) from dist before any deploy - they are gitignored, not licensed.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        lab: resolve(import.meta.dirname, 'lab.html'),
        player: resolve(import.meta.dirname, 'player.html'),
        cast: resolve(import.meta.dirname, 'cast.html'),
        view: resolve(import.meta.dirname, 'view.html'),
      },
    },
  },
})
