// glyphcast WS relay (Bun): one caster broadcasts packed wire frames to N
// viewers. Dumb pipe - no decode, no buffering beyond the socket. Sends the
// text control message "key" to the caster whenever a viewer joins (or the
// caster connects with viewers waiting) so it resets state -> keyframe.
// permessage-deflate on: the transport-level entropy coding the wire format
// deliberately leaves out. Run: bun server/relay.ts [port=8788]
// Test strategy: E2E via cast.html + view.html state-checksum convergence.

type Role = 'cast' | 'view'

const port = Number(process.argv[2] ?? 8788)

type WS = Bun.ServerWebSocket<{ role: Role }>

let caster: WS | null = null
const viewers = new Set<WS>()
let castBytes = 0
let castPackets = 0

const server = Bun.serve<{ role: Role }, never>({
  port,
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/stats') {
      return Response.json({ caster: !!caster, viewers: viewers.size, castBytes, castPackets })
    }
    const role: Role = url.searchParams.get('role') === 'cast' ? 'cast' : 'view'
    if (srv.upgrade(req, { data: { role } })) return undefined
    return new Response('glyphcast relay: ws?role=cast|view, GET /stats', { status: 200 })
  },
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      if (ws.data.role === 'cast') {
        caster = ws
        if (viewers.size > 0) ws.send('key')
      } else {
        viewers.add(ws)
        caster?.send('key')
      }
    },
    message(ws, msg) {
      if (ws.data.role !== 'cast' || typeof msg === 'string') return
      castBytes += msg.byteLength
      castPackets++
      for (const v of viewers) v.send(msg)
    },
    close(ws) {
      if (ws === caster) caster = null
      viewers.delete(ws)
    },
  },
})

console.log(`glyphcast relay on ws://localhost:${server.port}`)
