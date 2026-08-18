import { describe, expect, it } from 'vitest'
import { inspectIsoBmffMediaMetadata, inspectWaveDurationSeconds } from './media-container-metadata'

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(header.length + payload.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function durationBox(type: 'mvhd' | 'mdhd', timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(20)
  payload.writeUInt32BE(timescale, 12)
  payload.writeUInt32BE(duration, 16)
  return box(type, payload)
}

function trackHeader(width: number, height: number, rotated = false): Buffer {
  const payload = Buffer.alloc(84)
  if (rotated) {
    payload.writeInt32BE(65_536, 44)
    payload.writeInt32BE(-65_536, 52)
  } else {
    payload.writeInt32BE(65_536, 40)
    payload.writeInt32BE(65_536, 56)
  }
  payload.writeUInt32BE(width * 65_536, 76)
  payload.writeUInt32BE(height * 65_536, 80)
  return box('tkhd', payload)
}

function handler(kind: 'vide' | 'soun'): Buffer {
  const payload = Buffer.alloc(12)
  payload.write(kind, 8, 4, 'ascii')
  return box('hdlr', payload)
}

function isoFixture(rotated = false): Buffer {
  const videoTrack = box('trak', Buffer.concat([
    trackHeader(1_920, 1_080, rotated),
    box('mdia', Buffer.concat([durationBox('mdhd', 1_000, 2_500), handler('vide')])),
  ]))
  const audioTrack = box('trak', box('mdia', Buffer.concat([
    durationBox('mdhd', 48_000, 120_000),
    handler('soun'),
  ])))
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0', 'binary')),
    box('moov', Buffer.concat([durationBox('mvhd', 1_000, 2_500), videoTrack, audioTrack])),
  ])
}

function pcmWav(overrides: { format?: number; sampleRate?: number; blockAlign?: number; dataBytes?: number } = {}): Buffer {
  const format = overrides.format ?? 1
  const sampleRate = overrides.sampleRate ?? 8_000
  const blockAlign = overrides.blockAlign ?? 2
  const dataBytes = overrides.dataBytes ?? 16_000
  const bytes = Buffer.alloc(44 + dataBytes)
  bytes.write('RIFF', 0, 4, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8, 4, 'ascii')
  bytes.write('fmt ', 12, 4, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(format, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * blockAlign, 28)
  bytes.writeUInt16LE(blockAlign, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 4, 'ascii')
  bytes.writeUInt32LE(dataBytes, 40)
  return bytes
}

describe('inspectIsoBmffMediaMetadata', () => {
  it('reads movie, video and audio durations plus track dimensions', () => {
    expect(inspectIsoBmffMediaMetadata(isoFixture())).toEqual({
      durationSeconds: 2.5,
      video: { width: 1_920, height: 1_080, durationSeconds: 2.5 },
      audioDurationSeconds: 2.5,
    })
  })

  it('swaps display dimensions for a quarter-turn track matrix', () => {
    expect(inspectIsoBmffMediaMetadata(isoFixture(true)).video).toMatchObject({ width: 1_080, height: 1_920 })
  })

  it.each([
    ['non-ISO input', Buffer.from('not a media container')],
    ['truncated extended size', Buffer.from([0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])],
    ['out-of-bounds box', Buffer.from([0, 0, 1, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0])],
  ])('returns no metadata for %s', (_label, bytes) => {
    expect(inspectIsoBmffMediaMetadata(bytes)).toEqual({})
  })

  it('bounds pathological box counts', () => {
    const tinyBoxes = Buffer.concat(Array.from({ length: 10_001 }, () => box('free', Buffer.alloc(0))))
    const bytes = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'binary')), box('moov', tinyBoxes)])
    expect(inspectIsoBmffMediaMetadata(bytes)).toEqual({})
  })

  it('ignores zero timescales and duration sentinels', () => {
    const zeroScale = Buffer.concat([
      box('ftyp', Buffer.from('isom\0\0\0\0', 'binary')),
      box('moov', durationBox('mvhd', 0, 1_000)),
    ])
    const sentinel = durationBox('mvhd', 1_000, 0xffff_ffff)
    expect(inspectIsoBmffMediaMetadata(zeroScale)).toEqual({})
    expect(inspectIsoBmffMediaMetadata(Buffer.concat([
      box('ftyp', Buffer.from('isom\0\0\0\0', 'binary')),
      box('moov', sentinel),
    ]))).toEqual({})
  })
})

describe('inspectWaveDurationSeconds', () => {
  it('reads a bounded PCM WAV duration', () => {
    expect(inspectWaveDurationSeconds(pcmWav())).toBe(1)
  })

  it('rejects unsupported formats, divide-by-zero metadata and truncated chunks', () => {
    expect(inspectWaveDurationSeconds(pcmWav({ format: 7 }))).toBeUndefined()
    expect(inspectWaveDurationSeconds(pcmWav({ sampleRate: 0 }))).toBeUndefined()
    expect(inspectWaveDurationSeconds(pcmWav({ blockAlign: 0 }))).toBeUndefined()
    expect(inspectWaveDurationSeconds(pcmWav().subarray(0, 40))).toBeUndefined()
  })
})
