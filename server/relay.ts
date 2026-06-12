// glyphcast WS relay (Bun): named channels ("stations"), each with one caster
// broadcasting packed wire frames to N viewers. Dumb pipe - no decode, no
// buffering beyond the socket. Sends the text control message "key" to a
// channel's caster whenever a viewer joins (or the caster connects with
// viewers waiting) so it resets state -> keyframe. permessage-deflate on:
// the transport-level entropy coding the wire format deliberately leaves out.
// Run: bun server/relay.ts [port=8788]. WS: /?role=cast|view&ch=<channel>
// Test strategy: E2E via cast/view/term checksum convergence + cross-channel
// isolation (a viewer on channel B must receive nothing from channel A).

type Role = 'cast' | 'view'

const port = Number(process.argv[2] ?? 8788)

type WS = Bun.ServerWebSocket<{ role: Role; ch: string }>
type Room = { caster: WS | null; viewers: Set<WS>; castBytes: number; castPackets: number }

const rooms = new Map<string, Room>()

function room(ch: string): Room {
  let r = rooms.get(ch)
  if (!r) {
    r = { caster: null, viewers: new Set(), castBytes: 0, castPackets: 0 }
    rooms.set(ch, r)
  }
  return r
}

const server = Bun.serve<{ role: Role; ch: string }, never>({
  port,
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/stats') {
      const channels: Record<string, { caster: boolean; viewers: number; castBytes: number; castPackets: number }> = {}
      for (const [ch, r] of rooms) {
        channels[ch] = { caster: !!r.caster, viewers: r.viewers.size, castBytes: r.castBytes, castPackets: r.castPackets }
      }
      return Response.json({ channels })
    }
    const role: Role = url.searchParams.get('role') === 'cast' ? 'cast' : 'view'
    const ch = url.searchParams.get('ch') || 'main'
    if (srv.upgrade(req, { data: { role, ch } })) return undefined
    return new Response('glyphcast relay: ws?role=cast|view&ch=<channel>, GET /stats', { status: 200 })
  },
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      const r = room(ws.data.ch)
      if (ws.data.role === 'cast') {
        r.caster = ws
        if (r.viewers.size > 0) ws.send('key')
      } else {
        r.viewers.add(ws)
        r.caster?.send('key')
      }
    },
    message(ws, msg) {
      if (ws.data.role !== 'cast' || typeof msg === 'string') return
      const r = room(ws.data.ch)
      if (r.caster !== ws) return
      r.castBytes += msg.byteLength
      r.castPackets++
      for (const v of r.viewers) v.send(msg)
    },
    close(ws) {
      const r = rooms.get(ws.data.ch)
      if (!r) return
      if (r.caster === ws) r.caster = null
      r.viewers.delete(ws)
      if (!r.caster && r.viewers.size === 0) rooms.delete(ws.data.ch)
    },
  },
})

console.log(`glyphcast relay on ws://localhost:${server.port}`)
