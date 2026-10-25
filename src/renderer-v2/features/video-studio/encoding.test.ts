import { describe, expect, it } from 'vitest'
import { chooseVideoStudioEncoding, type VideoStudioAudioCodec, type VideoStudioEncodeProbe, type VideoStudioVideoCodec } from './encoding'

const output = { width: 1280, height: 720, frameRate: 30, sampleRate: 48_000, numberOfChannels: 2 }

function probe(video: VideoStudioVideoCodec[], audio: VideoStudioAudioCodec[], asked: string[] = []): VideoStudioEncodeProbe {
  return {
    async video(codec, size) {
      asked.push(`video ${codec} ${size.width}x${size.height}@${size.frameRate}`)
      return video.includes(codec)
    },
    async audio(codec, format) {
      asked.push(`audio ${codec} ${format.sampleRate}/${format.numberOfChannels}`)
      return audio.includes(codec)
    },
  }
}

describe('video studio encoding', () => {
  it('picks H.264 and AAC when the machine has both', async () => {
    const asked: string[] = []
    expect(await chooseVideoStudioEncoding(output, true, probe(['avc', 'vp9'], ['aac', 'opus'], asked))).toEqual({ video: 'avc', audio: 'aac' })
    expect(asked).toEqual(['video avc 1280x720@30', 'audio aac 48000/2'])
  })

  it('falls back to Opus where there is no AAC encoder', async () => {
    expect(await chooseVideoStudioEncoding(output, true, probe(['avc'], ['opus']))).toEqual({ video: 'avc', audio: 'opus' })
  })

  it('falls back to VP9 and then AV1 for the picture', async () => {
    expect(await chooseVideoStudioEncoding(output, false, probe(['vp9', 'av1'], []))).toEqual({ video: 'vp9', audio: null })
    expect(await chooseVideoStudioEncoding(output, false, probe(['av1'], []))).toEqual({ video: 'av1', audio: null })
  })

  it('does not ask for an audio encoder when no clip has sound', async () => {
    const asked: string[] = []
    expect(await chooseVideoStudioEncoding(output, false, probe(['avc'], [], asked))).toEqual({ video: 'avc', audio: null })
    expect(asked).toEqual(['video avc 1280x720@30'])
  })

  it('treats a probe that throws as unsupported', async () => {
    const failing: VideoStudioEncodeProbe = {
      async video(codec) {
        if (codec === 'avc') throw new Error('encoder crashed')
        return true
      },
      async audio() { return true },
    }
    expect(await chooseVideoStudioEncoding(output, true, failing)).toEqual({ video: 'vp9', audio: 'aac' })
  })

  it('follows an explicit preference', async () => {
    expect(await chooseVideoStudioEncoding(output, true, probe(['avc', 'vp9'], ['aac', 'opus']), { video: ['vp9'], audio: ['opus'] }))
      .toEqual({ video: 'vp9', audio: 'opus' })
  })

  it('explains what is missing when nothing can encode', async () => {
    await expect(chooseVideoStudioEncoding(output, false, probe([], []))).rejects.toThrow('这台电脑的系统没有能用的视频编码器，导不出视频')
    await expect(chooseVideoStudioEncoding(output, true, probe(['avc'], []))).rejects.toThrow('这台电脑的系统没有能用的声音编码器，导不出带声音的视频')
  })
})
