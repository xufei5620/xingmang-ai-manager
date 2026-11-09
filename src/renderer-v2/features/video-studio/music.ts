import { createVideoStudioPcmAssembler, type VideoStudioDecodedAudio, type VideoStudioPcmChunk } from './pcm'

// 配乐：一首歌从成片开头放起，比成片短就从头接着放，结尾几秒淡出，混进片段原声里。
// 拼片时声音按块交给编码器（pcm.ts），块是按顺序一块接一块的，所以配乐也只需要顺着往下解，
// 永远不用回头，整首歌不必一次解进内存。

export interface VideoStudioMusicSource {
  /** 这首歌有多长（秒）；不到一帧的当作读不出来。 */
  duration: number
  /** 从头解一遍这首歌。每一小段的 startTime 是它在歌里的时间。 */
  samples(): AsyncIterable<VideoStudioDecodedAudio>
}

export interface VideoStudioMusicMix {
  sampleRate: number
  chunkFrames: number
  /** 成片一共多少个采样帧；配乐只铺到这里。 */
  totalFrames: number
  /** 配乐的音量，0 到 1。 */
  gain: number
  /** 结尾淡出用多少个采样帧；成片比这还短时整段都在淡出。 */
  fadeFrames: number
}

export interface VideoStudioMusicMixer {
  /** 把配乐加进这一块（原地改），超出 [-1, 1] 的截掉。块要按顺序给。 */
  mixInto(chunk: VideoStudioPcmChunk): Promise<void>
}

/** 混好以后截到 [-1, 1]：两路声音都响时加起来会超，编码器拿到超出的值会爆音。 */
function clampSample(value: number): number {
  return value > 1 ? 1 : value < -1 ? -1 : value
}

export function createVideoStudioMusicMixer(source: VideoStudioMusicSource, mix: VideoStudioMusicMix): VideoStudioMusicMixer {
  const { sampleRate, chunkFrames, totalFrames, gain, fadeFrames } = mix
  const channels = 2
  // 解出来的配乐重采样成跟片段一样的格式，块边界也跟片段那一路对齐（同样从 0 起、同样大小）。
  const ready: VideoStudioPcmChunk[] = []
  let readyEnd = 0
  const assembler = createVideoStudioPcmAssembler({
    sampleRate,
    chunkFrames,
    async emit(chunk) {
      ready.push(chunk)
      readyEnd = chunk.firstFrame + chunk.frameCount
    },
  })
  const playable = Number.isFinite(source.duration) && source.duration * sampleRate >= 1
  let loopOffset = 0
  let iterator: AsyncIterator<VideoStudioDecodedAudio> | null = null
  let finished = !playable || gain <= 0 || totalFrames <= 0
  let heardAnything = false

  async function finish() {
    finished = true
    await assembler.finish(totalFrames)
  }

  // 再往下解一小段；歌放完了就从头再来，铺满成片就收尾。
  async function pull() {
    iterator ??= source.samples()[Symbol.asyncIterator]()
    const next = await iterator.next()
    if (next.done) {
      iterator = null
      // 一整遍什么都没解出来就别转圈了：再来一遍也是一样。
      if (!heardAnything) { await finish(); return }
      loopOffset += source.duration
      if (loopOffset * sampleRate >= totalFrames) await finish()
      return
    }
    const audio = next.value
    heardAnything = true
    const startTime = audio.startTime + loopOffset
    if (startTime * sampleRate >= totalFrames) { await finish(); return }
    // 每一遍只铺这一遍自己的那段时间：解码器多给的尾巴不会盖到下一遍的开头。
    const windowEnd = Math.min(totalFrames, Math.round((loopOffset + source.duration) * sampleRate))
    await assembler.add({ ...audio, startTime }, Math.round(loopOffset * sampleRate), windowEnd)
  }

  function envelope(frame: number): number {
    const left = totalFrames - frame
    return left >= fadeFrames ? gain : gain * Math.max(0, left) / fadeFrames
  }

  return {
    async mixInto(chunk) {
      const end = chunk.firstFrame + chunk.frameCount
      while (!finished && readyEnd < end) await pull()
      // 用过的块扔掉，内存里只留还没混的那一两块。
      while (ready.length && ready[0].firstFrame + ready[0].frameCount <= chunk.firstFrame) ready.shift()
      for (const music of ready) {
        const first = Math.max(chunk.firstFrame, music.firstFrame)
        const last = Math.min(end, music.firstFrame + music.frameCount)
        for (let frame = first; frame < last; frame += 1) {
          const level = envelope(frame)
          const target = (frame - chunk.firstFrame) * channels
          const from = (frame - music.firstFrame) * channels
          for (let channel = 0; channel < channels; channel += 1) {
            chunk.data[target + channel] = clampSample(chunk.data[target + channel] + level * music.data[from + channel])
          }
        }
      }
    },
  }
}
