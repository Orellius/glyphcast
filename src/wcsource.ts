// glyphcast WebCodecs frame source: fetch -> mp4box demux -> VideoDecoder.
// No <video> element anywhere, so no autoplay policy can gate the caster -
// in any browser, foreground or hidden. Caches every EncodedVideoChunk on
// the first demux pass and loops the stream forever (first chunk is a
// keyframe by construction). Pacing is pull-based: the caller's tick calls
// pump(); due frames fire onFrame and stale ones are dropped, so a hidden
// tab's slow ticks degrade fps but never stall or leak.
// NOT responsible for: cell encoding or transport (cast.ts owns those).
// Test strategy: E2E - wc caster streams to TV + term with checksum parity.

import { createFile, DataStream, type ISOFile } from 'mp4box'

export type WcAudioConfig = { codec: string; sampleRate: number; channels: number; description?: Uint8Array }
type WcAudioChunk = { data: Uint8Array; timestampUs: number }

type WcSource = {
  pump: () => void
  dims: () => { w: number; h: number } | null
  audioConfig: () => WcAudioConfig | null
  close: () => void
}

export async function createWcSource(
  url: string,
  onFrame: (frame: VideoFrame) => void,
  onError: (msg: string) => void,
  onAudio?: (chunk: WcAudioChunk) => void,
): Promise<WcSource> {
  const ab = await (await fetch(url)).arrayBuffer()

  const chunks: EncodedVideoChunk[] = []
  const audioChunks: WcAudioChunk[] = []
  let config: VideoDecoderConfig | null = null
  let audioCfg: WcAudioConfig | null = null
  let dims: { w: number; h: number } | null = null

  await new Promise<void>((resolve, reject) => {
    const file = createFile()
    let total = 0
    let audioTotal = 0
    let audioId = -1
    const maybeDone = () => {
      if (chunks.length >= total && audioChunks.length >= audioTotal) resolve()
    }
    file.onError = (e: string) => reject(new Error(e))
    file.onReady = (info) => {
      const t = info.videoTracks[0]
      if (!t || !t.video) return reject(new Error('no video track'))
      total = t.nb_samples
      dims = { w: t.video.width, h: t.video.height }
      const desc = trackDescription(file, t.id)
      config = {
        codec: t.codec,
        codedWidth: t.video.width,
        codedHeight: t.video.height,
      }
      if (desc) config.description = desc
      file.setExtractionOptions(t.id, null, { nbSamples: total })
      const a = info.audioTracks[0]
      if (a && a.audio && onAudio) {
        audioId = a.id
        audioTotal = a.nb_samples
        audioCfg = { codec: a.codec, sampleRate: a.audio.sample_rate, channels: a.audio.channel_count }
        const adesc = audioSpecificConfig(file, a.id)
        if (adesc) audioCfg.description = adesc
        file.setExtractionOptions(a.id, null, { nbSamples: audioTotal })
      }
      file.start()
    }
    file.onSamples = (id, _user, samples) => {
      for (const s of samples) {
        if (!s.data) continue
        if (id === audioId) {
          audioChunks.push({ data: s.data, timestampUs: Math.round((1e6 * s.cts) / s.timescale) })
          continue
        }
        chunks.push(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: Math.round((1e6 * s.cts) / s.timescale),
            duration: Math.round((1e6 * s.duration) / s.timescale),
            data: s.data,
          }),
        )
      }
      maybeDone()
    }
    const buf = ab as ArrayBuffer & { fileStart: number }
    buf.fileStart = 0
    file.appendBuffer(buf)
    file.flush()
  })

  const cfg = config as VideoDecoderConfig | null
  if (!cfg || chunks.length === 0) throw new Error('demux produced no chunks')
  const support = await VideoDecoder.isConfigSupported(cfg)
  if (!support.supported) throw new Error(`codec unsupported: ${cfg.codec}`)

  const ready: VideoFrame[] = []
  const decoder = new VideoDecoder({
    output: (f) => ready.push(f),
    error: (e) => onError(e.message),
  })
  decoder.configure(cfg)

  const durationUs = chunks[chunks.length - 1].timestamp + (chunks[chunks.length - 1].duration ?? 0)
  let idx = 0
  let audioIdx = 0
  let loopBaseUs = 0
  let clock0 = performance.now()
  let closed = false
  const t0 = chunks[0].timestamp

  function pump() {
    if (closed) return
    // ship audio ahead of the clock (the viewer schedules by timestamp)
    if (onAudio) {
      const aheadUs = (performance.now() - clock0) * 1000 + 600_000
      while (audioIdx < audioChunks.length && loopBaseUs + audioChunks[audioIdx].timestampUs - t0 <= aheadUs) {
        const a = audioChunks[audioIdx++]
        onAudio({ data: a.data, timestampUs: loopBaseUs + a.timestampUs - t0 })
      }
    }
    // keep the decoder fed a little ahead
    while (idx < chunks.length && decoder.decodeQueueSize < 6 && ready.length < 6) {
      decoder.decode(chunks[idx++])
    }
    if (idx >= chunks.length && decoder.decodeQueueSize === 0 && ready.length === 0) {
      // loop: restart the stream clock and re-feed from the keyframe
      loopBaseUs += durationUs
      idx = 0
      audioIdx = 0
      return
    }
    const nowUs = (performance.now() - clock0) * 1000
    // emit the newest due frame, drop older due ones (hidden-tab slow ticks)
    let emit: VideoFrame | null = null
    while (ready.length && loopBaseUs + ready[0].timestamp - t0 <= nowUs) {
      if (emit) emit.close()
      emit = ready.shift()!
    }
    if (emit) {
      onFrame(emit)
      emit.close()
    }
  }

  // align the clock to the first emitted frame
  clock0 = performance.now()
  return {
    pump,
    dims: () => dims,
    audioConfig: () => audioCfg,
    close: () => {
      closed = true
      for (const f of ready) f.close()
      ready.length = 0
      if (decoder.state !== 'closed') decoder.close()
    },
  }
}

// codec private data (avcC/hvcC/vpcC/av1C) for VideoDecoderConfig.description
function trackDescription(file: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = (file as unknown as { getTrackById: (id: number) => { mdia: { minf: { stbl: { stsd: { entries: Record<string, { write: (s: DataStream) => void } | undefined>[] } } } } } }).getTrackById(trackId)
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (box) {
      const stream = new DataStream() // defaults to big-endian
      box.write(stream)
      return new Uint8Array(stream.buffer as ArrayBuffer, 8) // skip box size+type header
    }
  }
  return undefined
}

// AAC AudioSpecificConfig from the esds box (DecoderConfigDescriptor tag 4 ->
// DecoderSpecificInfo tag 5); box layout walked loosely, absent = no desc
function audioSpecificConfig(file: ISOFile, trackId: number): Uint8Array | undefined {
  try {
    const trak = (file as unknown as { getTrackById: (id: number) => { mdia: { minf: { stbl: { stsd: { entries: { esds?: { esd?: { descs?: { tag: number; descs?: { tag: number; data?: Uint8Array }[] }[] } } }[] } } } } } }).getTrackById(trackId)
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const dcd = entry.esds?.esd?.descs?.find((d) => d.tag === 4)
      const dsi = dcd?.descs?.find((d) => d.tag === 5)
      if (dsi?.data) return new Uint8Array(dsi.data)
    }
  } catch {
    // tolerated: stream plays silent rather than failing the cast
  }
  return undefined
}
