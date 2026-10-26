import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from 'mediabunny'
import { composeVideoStudio } from './compose'
import { composeInVideoStudioWorker } from './compose-client'
import type { VideoStudioComposeProgress, VideoStudioComposeRequest, VideoStudioComposeResult } from './compose-protocol'

// 浏览器里真跑一遍拼片：先用同一套编码器现做几段纯色片段（带或不带正弦音），拼完再
// 把成片解出来，量指定位置的颜色和指定时间段的音量。全程不碰网络，不需要真的 AI 片段。

interface FixtureClipSpec {
  width: number
  height: number
  frameRate: number
  seconds: number
  color: string
  tone?: { frequency: number, channels: number }
}

interface FixtureProbe {
  colors?: Array<{ time: number, x: number, y: number }>
  bright?: Array<{ time: number, top: number, bottom: number }>
  loudness?: Array<{ from: number, to: number }>
}

interface FixtureComposeOptions {
  abortAt?: number
  worker?: boolean
}

const fixtureSampleRate = 48_000

async function makeClip(spec: FixtureClipSpec): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(spec.width, spec.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d context')
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9'], { width: spec.width, height: spec.height })
  if (!codec) throw new Error('no video encoder')
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const video = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH })
  output.addVideoTrack(video, { frameRate: spec.frameRate })
  const audio = spec.tone ? new AudioSampleSource({ codec: 'opus', quality: QUALITY_HIGH }) : null
  if (audio) output.addAudioTrack(audio)
  await output.start()
  const frames = Math.round(spec.seconds * spec.frameRate)
  for (let index = 0; index < frames; index += 1) {
    context.fillStyle = spec.color
    context.fillRect(0, 0, spec.width, spec.height)
    await video.add(index / spec.frameRate, 1 / spec.frameRate)
  }
  if (audio && spec.tone) {
    const { frequency, channels } = spec.tone
    const total = Math.round(spec.seconds * fixtureSampleRate)
    const chunk = fixtureSampleRate / 10
    for (let first = 0; first < total; first += chunk) {
      const count = Math.min(chunk, total - first)
      const data = new Float32Array(count * channels)
      for (let frame = 0; frame < count; frame += 1) {
        const value = 0.5 * Math.sin(2 * Math.PI * frequency * (first + frame) / fixtureSampleRate)
        for (let channel = 0; channel < channels; channel += 1) data[frame * channels + channel] = value
      }
      const sample = new AudioSample({ data, format: 'f32', numberOfChannels: channels, sampleRate: fixtureSampleRate, timestamp: first / fixtureSampleRate })
      await audio.add(sample)
      sample.close()
    }
  }
  await output.finalize()
  if (!target.buffer) throw new Error('clip was not written')
  return target.buffer
}

// 三段尺寸、帧率、声音都不一样的片段：红色带立体声和字幕、蓝色竖屏没声音、绿色带单声道。
async function sampleClips(): Promise<VideoStudioComposeRequest['clips']> {
  return [
    { data: await makeClip({ width: 320, height: 240, frameRate: 24, seconds: 1, color: '#ff0000', tone: { frequency: 440, channels: 2 } }), caption: 'Hello 星芒' },
    { data: await makeClip({ width: 240, height: 320, frameRate: 30, seconds: 1.5, color: '#0000ff' }) },
    { data: await makeClip({ width: 320, height: 180, frameRate: 25, seconds: 1, color: '#00ff00', tone: { frequency: 660, channels: 1 } }) },
  ]
}

async function inspect(data: ArrayBuffer, probe: FixtureProbe = {}) {
  const input = new Input({ source: new BufferSource(data), formats: [MP4] })
  const video = await input.getPrimaryVideoTrack()
  if (!video) throw new Error('output has no video track')
  const audio = await input.getPrimaryAudioTrack()
  const reader = new OffscreenCanvas(video.displayWidth, video.displayHeight)
  const context = reader.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('no 2d context')
  const sink = new CanvasSink(video)
  async function frameAt(time: number) {
    const frame = await sink.getCanvas(time)
    if (!frame) throw new Error(`no frame at ${time}`)
    context?.drawImage(frame.canvas, 0, 0)
  }
  const colors = []
  for (const point of probe.colors ?? []) {
    await frameAt(point.time)
    colors.push(Array.from(context.getImageData(point.x, point.y, 1, 1).data.slice(0, 3)))
  }
  const bright = []
  for (const band of probe.bright ?? []) {
    await frameAt(band.time)
    const pixels = context.getImageData(0, band.top, reader.width, band.bottom - band.top).data
    let count = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 200 && pixels[index + 1] > 200 && pixels[index + 2] > 200) count += 1
    }
    bright.push(count)
  }
  const loudness = []
  if (audio) {
    const samples = new AudioSampleSink(audio)
    for (const window of probe.loudness ?? []) {
      let sum = 0
      let count = 0
      for await (const sample of samples.samples(window.from, window.to)) {
        const values = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32' }) / 4)
        sample.copyTo(values, { planeIndex: 0, format: 'f32' })
        const firstFrame = Math.max(0, Math.ceil((window.from - sample.timestamp) * sample.sampleRate))
        const lastFrame = Math.min(sample.numberOfFrames, Math.floor((window.to - sample.timestamp) * sample.sampleRate))
        for (let frame = firstFrame; frame < lastFrame; frame += 1) {
          const value = values[frame * sample.numberOfChannels]
          sum += value * value
          count += 1
        }
        sample.close()
      }
      loudness.push(count ? Math.sqrt(sum / count) : 0)
    }
  }
  const summary = {
    duration: await input.computeDuration(),
    videoDuration: await video.computeDuration(),
    width: video.displayWidth,
    height: video.displayHeight,
    videoCodec: video.codec,
    packetCount: (await video.computePacketStats()).packetCount,
    audioCodec: audio?.codec ?? null,
    audioDuration: audio ? await audio.computeDuration() : null,
    audioSampleRate: audio?.sampleRate ?? null,
    audioChannels: audio?.numberOfChannels ?? null,
    colors,
    bright,
    loudness,
  }
  input.dispose()
  return summary
}

async function compose(request: VideoStudioComposeRequest, options: FixtureComposeOptions = {}): Promise<VideoStudioComposeResult & { progress: VideoStudioComposeProgress[] }> {
  const controller = new AbortController()
  const progress: VideoStudioComposeProgress[] = []
  function onProgress(value: VideoStudioComposeProgress) {
    progress.push(value)
    if (options.abortAt !== undefined && value.ratio >= options.abortAt) controller.abort()
  }
  const result = options.worker
    ? await composeInVideoStudioWorker(request, { signal: controller.signal, onProgress })
    : await composeVideoStudio(request, { signal: controller.signal, onProgress })
  return { ...result, progress }
}

async function failure(run: () => Promise<unknown>): Promise<{ name: string, message: string }> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error || error instanceof DOMException ? { name: error.name, message: error.message } : { name: 'unknown', message: String(error) }
  }
  return { name: 'none', message: 'the call did not fail' }
}

declare global {
  interface Window {
    videoStudioHarness?: {
      makeClip: typeof makeClip
      sampleClips: typeof sampleClips
      inspect: typeof inspect
      compose: typeof compose
      failure: typeof failure
    }
  }
}

window.videoStudioHarness = { makeClip, sampleClips, inspect, compose, failure }
