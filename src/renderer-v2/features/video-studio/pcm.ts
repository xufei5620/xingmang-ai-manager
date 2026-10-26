/** 解码出来的一小段声音：交错排列的 32 位浮点，起点已经换算到成片的时间轴上。 */
export interface VideoStudioDecodedAudio {
  data: Float32Array
  frameCount: number
  channelCount: number
  sampleRate: number
  /** 这一小段第一个采样在成片上的时间（秒）。 */
  startTime: number
}

/** 交给编码器的一块：固定的采样率和声道数，首尾相接、不重叠、不留缝。 */
export interface VideoStudioPcmChunk {
  data: Float32Array
  firstFrame: number
  frameCount: number
}

export interface VideoStudioPcmAssembler {
  /**
   * 把一小段声音重采样后写进成片，只写落在 [windowStart, windowEnd) 里的采样帧。
   * 窗口就是这段片段在成片上占的位置，多解出来的尾巴不会渗进下一段。
   */
  add(audio: VideoStudioDecodedAudio, windowStart: number, windowEnd: number): Promise<void>
  /** 把 totalFrames 之前还没交出去的都交出去，没写到的地方是静音。 */
  finish(totalFrames: number): Promise<void>
}

export interface VideoStudioPcmAssemblerOptions {
  sampleRate: number
  chunkFrames: number
  emit(chunk: VideoStudioPcmChunk): Promise<void>
}

const outputChannels = 2

// Downmix coefficients follow the Web Audio "speakers" rules, so a clip sounds
// the way the browser itself would play it on a stereo device.
export function mixToStereo(data: Float32Array, frame: number, channelCount: number, target: 0 | 1): number {
  const base = frame * channelCount
  if (channelCount === 1) return data[base]
  if (channelCount === 4) return 0.5 * (data[base + target] + data[base + 2 + target])
  if (channelCount === 6) return data[base + target] + Math.SQRT1_2 * (data[base + 2] + data[base + 4 + target])
  return data[base + Math.min(target, channelCount - 1)]
}

// Every clip arrives at whatever rate its decoder chose (44.1 kHz, 48 kHz,
// 24 kHz…), and mediabunny's own resampler locks onto the rate of the first
// sample it sees. So the timeline is resampled here, into one fixed format,
// before the encoder ever sees it. Linear interpolation is what the browser's
// own resampler does as well; the clips are short-form speech and music.
export function createVideoStudioPcmAssembler(options: VideoStudioPcmAssemblerOptions): VideoStudioPcmAssembler {
  const { sampleRate, chunkFrames, emit } = options
  if (!Number.isInteger(chunkFrames) || chunkFrames <= 0) throw new RangeError('chunkFrames must be a positive integer')
  let buffer = new Float32Array(chunkFrames * outputChannels)
  let bufferStart = 0
  let finished = false

  async function flush(frameCount: number) {
    const data = buffer.slice(0, frameCount * outputChannels)
    const firstFrame = bufferStart
    bufferStart += frameCount
    buffer = new Float32Array(chunkFrames * outputChannels)
    await emit({ data, firstFrame, frameCount })
  }

  return {
    async add(audio, windowStart, windowEnd) {
      if (finished) throw new Error('the assembler has already finished')
      if (audio.frameCount <= 0 || audio.channelCount <= 0 || audio.sampleRate <= 0) return
      const audioEnd = audio.startTime + audio.frameCount / audio.sampleRate
      const first = Math.max(windowStart, bufferStart, Math.ceil(audio.startTime * sampleRate - 1e-6))
      const end = Math.min(windowEnd, Math.ceil(audioEnd * sampleRate - 1e-6))
      for (let frame = first; frame < end; frame += 1) {
        while (frame >= bufferStart + chunkFrames) await flush(chunkFrames)
        const position = Math.max(0, (frame / sampleRate - audio.startTime) * audio.sampleRate)
        const lower = Math.min(Math.floor(position), audio.frameCount - 1)
        const upper = Math.min(lower + 1, audio.frameCount - 1)
        const fraction = position - lower
        const offset = (frame - bufferStart) * outputChannels
        for (let channel = 0; channel < outputChannels; channel += 1) {
          const target = channel === 0 ? 0 : 1
          const low = mixToStereo(audio.data, lower, audio.channelCount, target)
          const high = mixToStereo(audio.data, upper, audio.channelCount, target)
          buffer[offset + channel] = low + Math.min(1, fraction) * (high - low)
        }
      }
    },
    async finish(totalFrames) {
      if (finished) return
      finished = true
      while (bufferStart + chunkFrames <= totalFrames) await flush(chunkFrames)
      if (totalFrames > bufferStart) await flush(totalFrames - bufferStart)
    },
  }
}
