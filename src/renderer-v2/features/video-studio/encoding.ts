import { VideoStudioError } from './errors'

export type VideoStudioVideoCodec = 'avc' | 'vp9' | 'av1'
export type VideoStudioAudioCodec = 'aac' | 'opus'

// H.264 is what every phone, chat app and upload page plays, so it wins whenever
// this machine can encode it (Electron's bundled OpenH264 does on all three
// platforms). The other two only exist so a machine without it still gets a file.
export const videoStudioVideoCodecs: readonly VideoStudioVideoCodec[] = ['avc', 'vp9', 'av1']
// Chromium on Linux ships no AAC encoder; Opus inside MP4 is the fallback there.
export const videoStudioAudioCodecs: readonly VideoStudioAudioCodec[] = ['aac', 'opus']

export interface VideoStudioEncodeProbe {
  video(codec: VideoStudioVideoCodec, size: { width: number, height: number, frameRate: number }): Promise<boolean>
  audio(codec: VideoStudioAudioCodec, format: { sampleRate: number, numberOfChannels: number }): Promise<boolean>
}

export interface VideoStudioEncodingPreference {
  video?: readonly VideoStudioVideoCodec[]
  audio?: readonly VideoStudioAudioCodec[]
}

export interface VideoStudioEncoding {
  video: VideoStudioVideoCodec
  /** 所有片段都没有声音时是 null，成片就不带音轨。 */
  audio: VideoStudioAudioCodec | null
}

export function isVideoStudioVideoCodec(value: unknown): value is VideoStudioVideoCodec {
  return typeof value === 'string' && (videoStudioVideoCodecs as readonly string[]).includes(value)
}

export function isVideoStudioAudioCodec(value: unknown): value is VideoStudioAudioCodec {
  return typeof value === 'string' && (videoStudioAudioCodecs as readonly string[]).includes(value)
}

async function firstSupported<T>(candidates: readonly T[], supported: (candidate: T) => Promise<boolean>): Promise<T | null> {
  for (const candidate of candidates) {
    // 探测本身抛错（比如编码器初始化失败）就当这台电脑不支持，接着试下一个。
    if (await supported(candidate).catch(() => false)) return candidate
  }
  return null
}

export async function chooseVideoStudioEncoding(
  output: { width: number, height: number, frameRate: number, sampleRate: number, numberOfChannels: number },
  needsAudio: boolean,
  probe: VideoStudioEncodeProbe,
  preference: VideoStudioEncodingPreference = {},
): Promise<VideoStudioEncoding> {
  const size = { width: output.width, height: output.height, frameRate: output.frameRate }
  const video = await firstSupported(preference.video ?? videoStudioVideoCodecs, (codec) => probe.video(codec, size))
  if (!video) throw new VideoStudioError('这台电脑的系统没有能用的视频编码器，导不出视频')
  if (!needsAudio) return { video, audio: null }
  const format = { sampleRate: output.sampleRate, numberOfChannels: output.numberOfChannels }
  const audio = await firstSupported(preference.audio ?? videoStudioAudioCodecs, (codec) => probe.audio(codec, format))
  if (!audio) throw new VideoStudioError('这台电脑的系统没有能用的声音编码器，导不出带声音的视频')
  return { video, audio }
}
