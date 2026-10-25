import { describe, expect, it } from 'vitest'
import { createVideoStudioPcmAssembler, mixToStereo, type VideoStudioPcmChunk } from './pcm'

function collect(sampleRate: number, chunkFrames: number) {
  const chunks: VideoStudioPcmChunk[] = []
  const assembler = createVideoStudioPcmAssembler({ sampleRate, chunkFrames, async emit(chunk) { chunks.push(chunk) } })
  function joined() {
    const frames = chunks.reduce((total, chunk) => total + chunk.frameCount, 0)
    const data = new Float32Array(frames * 2)
    for (const chunk of chunks) data.set(chunk.data, chunk.firstFrame * 2)
    return data
  }
  return { assembler, chunks, joined }
}

function constant(value: number, frames: number, channels: number) {
  return new Float32Array(frames * channels).fill(value)
}

describe('video studio pcm assembler', () => {
  it('downmixes the way the browser plays it on stereo speakers', () => {
    expect(mixToStereo(new Float32Array([0.5]), 0, 1, 0)).toBe(0.5)
    expect(mixToStereo(new Float32Array([0.5]), 0, 1, 1)).toBe(0.5)
    expect(mixToStereo(new Float32Array([0.1, 0.2]), 0, 2, 1)).toBeCloseTo(0.2)
    expect(mixToStereo(new Float32Array([0.2, 0.4, 0.6, 0.8]), 0, 4, 0)).toBeCloseTo(0.4)
    expect(mixToStereo(new Float32Array([0.1, 0.2, 0.3, 0.9, 0.4, 0.5]), 0, 6, 1)).toBeCloseTo(0.2 + Math.SQRT1_2 * (0.3 + 0.5))
    expect(mixToStereo(new Float32Array([0.1, 0.2, 0.3]), 0, 3, 1)).toBeCloseTo(0.2)
  })

  it('emits contiguous chunks and fills gaps with silence', async () => {
    const { assembler, chunks, joined } = collect(10, 4)
    await assembler.add({ data: constant(1, 3, 1), frameCount: 3, channelCount: 1, sampleRate: 10, startTime: 0.5 }, 0, 100)
    await assembler.finish(10)
    expect(chunks.map((chunk) => [chunk.firstFrame, chunk.frameCount])).toEqual([[0, 4], [4, 4], [8, 2]])
    expect(Array.from(joined().filter((_, index) => index % 2 === 0))).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 0, 0])
  })

  it('never writes outside the window of its segment', async () => {
    const { assembler, joined } = collect(10, 100)
    await assembler.add({ data: constant(1, 10, 2), frameCount: 10, channelCount: 2, sampleRate: 10, startTime: 0 }, 2, 5)
    await assembler.finish(10)
    expect(Array.from(joined().filter((_, index) => index % 2 === 1))).toEqual([0, 0, 1, 1, 1, 0, 0, 0, 0, 0])
  })

  it('resamples by interpolating between neighbouring frames', async () => {
    const { assembler, joined } = collect(4, 100)
    // 2 Hz 的源，0、1 两个采样；输出 4 Hz，中间那一帧落在两者正中间。
    await assembler.add({ data: new Float32Array([0, 1]), frameCount: 2, channelCount: 1, sampleRate: 2, startTime: 0 }, 0, 100)
    await assembler.finish(4)
    expect(Array.from(joined().filter((_, index) => index % 2 === 0))).toEqual([0, 0.5, 1, 1])
  })

  it('keeps a second clip at a different rate on its own position', async () => {
    const { assembler, joined } = collect(48_000, 48_000)
    await assembler.add({ data: constant(0.25, 44_100, 2), frameCount: 44_100, channelCount: 2, sampleRate: 44_100, startTime: 0 }, 0, 48_000)
    await assembler.add({ data: constant(0.5, 24_000, 1), frameCount: 24_000, channelCount: 1, sampleRate: 24_000, startTime: 1 }, 48_000, 96_000)
    await assembler.finish(96_000)
    const data = joined()
    expect(data).toHaveLength(96_000 * 2)
    expect(data[0]).toBe(0.25)
    expect(data[47_999 * 2 + 1]).toBe(0.25)
    expect(data[48_000 * 2]).toBe(0.5)
    expect(data[95_999 * 2 + 1]).toBe(0.5)
  })

  it('drops audio that arrives behind what has already been handed out', async () => {
    const { assembler, joined } = collect(10, 2)
    await assembler.add({ data: constant(1, 6, 1), frameCount: 6, channelCount: 1, sampleRate: 10, startTime: 0 }, 0, 100)
    await assembler.add({ data: constant(0.5, 6, 1), frameCount: 6, channelCount: 1, sampleRate: 10, startTime: 0 }, 0, 100)
    await assembler.finish(6)
    expect(Array.from(joined().filter((_, index) => index % 2 === 0))).toEqual([1, 1, 1, 1, 0.5, 0.5])
  })

  it('refuses audio after it has finished and finishes only once', async () => {
    const { assembler, chunks } = collect(10, 4)
    await assembler.finish(3)
    await assembler.finish(8)
    expect(chunks.map((chunk) => chunk.frameCount)).toEqual([3])
    await expect(assembler.add({ data: constant(1, 1, 1), frameCount: 1, channelCount: 1, sampleRate: 10, startTime: 0 }, 0, 1)).rejects.toThrow()
  })

  it('rejects a chunk size that would never flush', () => {
    expect(() => createVideoStudioPcmAssembler({ sampleRate: 10, chunkFrames: 0, async emit() {} })).toThrow(RangeError)
  })
})
