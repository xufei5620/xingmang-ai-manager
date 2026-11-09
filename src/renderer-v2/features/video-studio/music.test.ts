import { describe, expect, it } from 'vitest'
import { createVideoStudioMusicMixer, type VideoStudioMusicSource } from './music'
import type { VideoStudioDecodedAudio, VideoStudioPcmChunk } from './pcm'

// 一首「歌」：sampleRate 赫兹、seconds 秒、每一帧都是 value（单声道），切成 piece 帧一段交出来。
function song(sampleRate: number, seconds: number, value: number, piece = sampleRate): VideoStudioMusicSource & { passes: number } {
  const frames = Math.round(sampleRate * seconds)
  const source = {
    duration: seconds,
    passes: 0,
    async *samples(): AsyncGenerator<VideoStudioDecodedAudio> {
      source.passes += 1
      for (let first = 0; first < frames; first += piece) {
        const frameCount = Math.min(piece, frames - first)
        yield { data: new Float32Array(frameCount).fill(value), frameCount, channelCount: 1, sampleRate, startTime: first / sampleRate }
      }
    },
  }
  return source
}

function silentChunks(totalFrames: number, chunkFrames: number, value = 0): VideoStudioPcmChunk[] {
  const chunks: VideoStudioPcmChunk[] = []
  for (let first = 0; first < totalFrames; first += chunkFrames) {
    const frameCount = Math.min(chunkFrames, totalFrames - first)
    chunks.push({ data: new Float32Array(frameCount * 2).fill(value), firstFrame: first, frameCount })
  }
  return chunks
}

function left(chunks: VideoStudioPcmChunk[]): number[] {
  return chunks.flatMap((chunk) => Array.from(chunk.data.filter((_, index) => index % 2 === 0)))
}

describe('video studio music mixer', () => {
  it('lays a song under the film at its volume and fades the last frames out', async () => {
    const chunks = silentChunks(10, 4)
    const mixer = createVideoStudioMusicMixer(song(10, 2, 1, 3), { sampleRate: 10, chunkFrames: 4, totalFrames: 10, gain: 0.5, fadeFrames: 4 })
    for (const chunk of chunks) await mixer.mixInto(chunk)
    expect(left(chunks)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.375, 0.25, 0.125])
  })

  it('starts the song over when it is shorter than the film, and stops decoding once the film is covered', async () => {
    const chunks = silentChunks(10, 4)
    const source = song(10, 0.4, 1, 2)
    const mixer = createVideoStudioMusicMixer(source, { sampleRate: 10, chunkFrames: 4, totalFrames: 10, gain: 1, fadeFrames: 1 })
    for (const chunk of chunks) await mixer.mixInto(chunk)
    expect(left(chunks).slice(0, 9)).toEqual(Array(9).fill(1))
    expect(source.passes).toBe(3)
  })

  it('resamples the song onto the film rate and adds it to the sound already there, clipped to full scale', async () => {
    const chunks = silentChunks(8, 8, 0.75)
    const mixer = createVideoStudioMusicMixer(song(4, 2, 0.5), { sampleRate: 8, chunkFrames: 8, totalFrames: 8, gain: 1, fadeFrames: 1 })
    await mixer.mixInto(chunks[0])
    expect(left(chunks).slice(0, 7)).toEqual(Array(7).fill(1))
    expect(Array.from(chunks[0].data.slice(0, 2))).toEqual([1, 1])
  })

  it('leaves the sound alone when the song is silent, unreadable or turned all the way down', async () => {
    for (const [source, gain] of [[song(10, 0, 1), 1], [song(10, 2, 1), 0], [{ duration: 1, async *samples() {} }, 1]] as const) {
      const chunks = silentChunks(6, 4, 0.25)
      const mixer = createVideoStudioMusicMixer(source, { sampleRate: 10, chunkFrames: 4, totalFrames: 6, gain, fadeFrames: 2 })
      for (const chunk of chunks) await mixer.mixInto(chunk)
      expect(left(chunks)).toEqual(Array(6).fill(0.25))
    }
  })
})
