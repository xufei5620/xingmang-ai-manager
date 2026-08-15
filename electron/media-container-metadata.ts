interface IsoBox {
  type: string
  payloadStart: number
  end: number
}

export interface IsoBmffMediaMetadata {
  durationSeconds?: number
  video?: {
    width?: number
    height?: number
    durationSeconds?: number
  }
  audioDurationSeconds?: number
}

const MAXIMUM_BOXES = 10_000
const MAXIMUM_DURATION_SECONDS = 365 * 24 * 60 * 60
const MAXIMUM_DIMENSION = 65_535

function boxes(bytes: Buffer, start: number, end: number, budget: { count: number }): IsoBox[] {
  const result: IsoBox[] = []
  let offset = start
  while (offset + 8 <= end) {
    budget.count += 1
    if (budget.count > MAXIMUM_BOXES) throw new Error('媒体容器 box 数量超限')
    const size32 = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    let headerBytes = 8
    let size = size32
    if (size32 === 1) {
      if (offset + 16 > end) throw new Error('媒体容器 extended size 不完整')
      const largeSize = bytes.readBigUInt64BE(offset + 8)
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('媒体容器 box 过大')
      size = Number(largeSize)
      headerBytes = 16
    } else if (size32 === 0) {
      size = end - offset
    }
    if (size < headerBytes || offset + size > end) throw new Error('媒体容器 box 边界无效')
    result.push({ type, payloadStart: offset + headerBytes, end: offset + size })
    offset += size
  }
  if (offset !== end && bytes.subarray(offset, end).some((value) => value !== 0)) {
    throw new Error('媒体容器尾部数据无效')
  }
  return result
}

function boundedDuration(duration: bigint, timescale: number): number | undefined {
  if (!Number.isSafeInteger(timescale) || timescale <= 0 || duration <= 0n) return undefined
  const seconds = Number(duration) / timescale
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAXIMUM_DURATION_SECONDS) return undefined
  return Math.round(seconds * 1_000) / 1_000
}

function fullBoxDuration(bytes: Buffer, box: IsoBox): number | undefined {
  if (box.payloadStart + 20 > box.end) return undefined
  const version = bytes[box.payloadStart]
  if (version === 0) {
    const timescale = bytes.readUInt32BE(box.payloadStart + 12)
    const duration = BigInt(bytes.readUInt32BE(box.payloadStart + 16))
    if (duration === 0xffff_ffffn) return undefined
    return boundedDuration(duration, timescale)
  }
  if (version === 1 && box.payloadStart + 32 <= box.end) {
    const timescale = bytes.readUInt32BE(box.payloadStart + 20)
    const duration = bytes.readBigUInt64BE(box.payloadStart + 24)
    if (duration === 0xffff_ffff_ffff_ffffn) return undefined
    return boundedDuration(duration, timescale)
  }
  return undefined
}

function fixedDimension(value: number): number | undefined {
  const dimension = Math.round(value / 65_536)
  return dimension > 0 && dimension <= MAXIMUM_DIMENSION ? dimension : undefined
}

function trackDimensions(bytes: Buffer, box: IsoBox): { width?: number; height?: number } {
  const version = bytes[box.payloadStart]
  const widthOffset = version === 1 ? 88 : version === 0 ? 76 : -1
  if (widthOffset < 0 || box.payloadStart + widthOffset + 8 > box.end) return {}
  const width = fixedDimension(bytes.readUInt32BE(box.payloadStart + widthOffset))
  const height = fixedDimension(bytes.readUInt32BE(box.payloadStart + widthOffset + 4))
  return { ...(width ? { width } : {}), ...(height ? { height } : {}) }
}

function trackMetadata(bytes: Buffer, track: IsoBox, budget: { count: number }): {
  handler?: string
  width?: number
  height?: number
  durationSeconds?: number
} {
  const children = boxes(bytes, track.payloadStart, track.end, budget)
  const tkhd = children.find((box) => box.type === 'tkhd')
  const mdia = children.find((box) => box.type === 'mdia')
  let handler: string | undefined
  let durationSeconds: number | undefined
  if (mdia) {
    const mediaChildren = boxes(bytes, mdia.payloadStart, mdia.end, budget)
    const hdlr = mediaChildren.find((box) => box.type === 'hdlr')
    if (hdlr && hdlr.payloadStart + 12 <= hdlr.end) {
      handler = bytes.toString('ascii', hdlr.payloadStart + 8, hdlr.payloadStart + 12)
    }
    const mdhd = mediaChildren.find((box) => box.type === 'mdhd')
    if (mdhd) durationSeconds = fullBoxDuration(bytes, mdhd)
  }
  return {
    ...(handler ? { handler } : {}),
    ...(tkhd ? trackDimensions(bytes, tkhd) : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
  }
}

export function inspectIsoBmffMediaMetadata(bytes: Buffer): IsoBmffMediaMetadata {
  try {
    if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') return {}
    const budget = { count: 0 }
    const topLevel = boxes(bytes, 0, bytes.length, budget)
    const moov = topLevel.find((box) => box.type === 'moov')
    if (!moov) return {}
    const movieChildren = boxes(bytes, moov.payloadStart, moov.end, budget)
    const mvhd = movieChildren.find((box) => box.type === 'mvhd')
    const durationSeconds = mvhd ? fullBoxDuration(bytes, mvhd) : undefined
    const tracks = movieChildren
      .filter((box) => box.type === 'trak')
      .map((track) => trackMetadata(bytes, track, budget))
    const videoTrack = tracks.find((track) => track.handler === 'vide')
      ?? tracks.find((track) => track.width !== undefined || track.height !== undefined)
    const audioTrack = tracks.find((track) => track.handler === 'soun')
    return {
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(videoTrack ? { video: {
        ...(videoTrack.width ? { width: videoTrack.width } : {}),
        ...(videoTrack.height ? { height: videoTrack.height } : {}),
        ...(videoTrack.durationSeconds ? { durationSeconds: videoTrack.durationSeconds } : {}),
      } } : {}),
      ...(audioTrack?.durationSeconds ? { audioDurationSeconds: audioTrack.durationSeconds } : {}),
    }
  } catch {
    return {}
  }
}

export function inspectWaveDurationSeconds(bytes: Buffer): number | undefined {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined
  }
  const riffEnd = bytes.readUInt32LE(4) + 8
  if (riffEnd < 12 || riffEnd > bytes.length) return undefined
  let sampleRate: number | undefined
  let blockAlign: number | undefined
  let dataBytes: number | undefined
  let offset = 12
  while (offset + 8 <= riffEnd) {
    const type = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const payloadStart = offset + 8
    const payloadEnd = payloadStart + size
    if (payloadEnd > riffEnd) return undefined
    if (type === 'fmt ' && size >= 16) {
      const format = bytes.readUInt16LE(payloadStart)
      if (![1, 3, 0xfffe].includes(format)) return undefined
      sampleRate = bytes.readUInt32LE(payloadStart + 4)
      blockAlign = bytes.readUInt16LE(payloadStart + 12)
    } else if (type === 'data') {
      dataBytes = size
    }
    offset = payloadEnd + (size % 2)
  }
  if (!sampleRate || !blockAlign || dataBytes === undefined) return undefined
  return boundedDuration(BigInt(dataBytes), sampleRate * blockAlign)
}
