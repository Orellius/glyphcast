// Multi-page build: all five surfaces ship (the moat is now the homepage).
// public/ is copied wholesale by
// vite, so the build script must prune local-only clips (demo*.mp4,
// sample.mp4) from dist before any deploy - they are gitignored, not licensed.
// cleanUrls() mirrors Vercel's cleanUrls in dev so /lab works the same locally
// as on glyphcast.tv.
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const PAGES = ['lab', 'player', 'cast', 'view']

function cleanUrls(): Plugin {
  return {
    name: 'clean-urls-dev',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (PAGES.includes(path.slice(1))) req.url = req.url!.replace(path, `${path}.html`)
        else if (path === '/brand' || path === '/brand/') req.url = '/brand/index.html'
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [cleanUrls()],
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
