import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  QUALITY_HIGH,
  WEBM,
  type InputAudioTrack,
  type InputVideoTrack,
  type WrappedCanvas,
} from 'mediabunny'
import { layoutVideoStudioCaption, paintVideoStudioCaption, videoStudioCaptionFont } from './captions'
import type { VideoStudioComposeProgress, VideoStudioComposeRequest, VideoStudioComposeResult, VideoStudioComposeStage } from './compose-protocol'
import { chooseVideoStudioEncoding, type VideoStudioEncodeProbe } from './encoding'
import { throwIfVideoStudioAborted, VideoStudioError } from './errors'
import { createVideoStudioPcmAssembler, type VideoStudioPcmAssembler, type VideoStudioPcmChunk } from './pcm'
import {
  buildVideoStudioRenderPlan,
  videoStudioAudioChannels,
  videoStudioAudioSampleRate,
  videoStudioSamplesPerFrame,
  videoStudioSourceFrameTimes,
  type VideoStudioRenderPlan,
  type VideoStudioSegment,
} from './timeline'

export interface VideoStudioComposeHooks {
  signal?: AbortSignal
  onProgress?(progress: VideoStudioComposeProgress): void
  /** 只给测试用：换掉「这台电脑能编什么」的探测。 */
  probe?: VideoStudioEncodeProbe
}

interface ReadClip {
  input: Input
  video: InputVideoTrack
  audio: InputAudioTrack | null
  start: number
  end: number
}

// 进度三段的分量：读片段很快，几乎全部时间花在逐帧画和编码上。
const stageWeights: Record<VideoStudioComposeStage, [number, number]> = {
  reading: [0, 0.05],
  rendering: [0.05, 0.95],
  finishing: [0.95, 1],
}
const readableFormats = [MP4, QTFF, WEBM, MATROSKA]

const mediabunnyEncodeProbe: VideoStudioEncodeProbe = {
  video(codec, size) {
    return canEncodeVideo(codec, { ...size, quality: QUALITY_HIGH })
  },
  audio(codec, format) {
    return canEncodeAudio(codec, { ...format, quality: QUALITY_HIGH })
  },
}

function createProgressReporter(onProgress: VideoStudioComposeHooks['onProgress']) {
  let lastStage: VideoStudioComposeStage | null = null
  let lastRatio = -1
  return function report(stage: VideoStudioComposeStage, fraction: number) {
    if (!onProgress) return
    const [from, to] = stageWeights[stage]
    const ratio = from + (to - from) * Math.min(1, Math.max(0, fraction))
    // 一帧报一次会在长片子上发几千条消息，进度条每走半个百分点再报。
    if (stage === lastStage && ratio - lastRatio < 0.005 && fraction < 1) return
    lastStage = stage
    lastRatio = ratio
    onProgress({ stage, ratio })
  }
}

async function readClip(data: ArrayBuffer, index: number): Promise<ReadClip> {
  const label = `第 ${index + 1} 段`
  const input = new Input({ source: new BufferSource(data), formats: readableFormats })
  try {
    if (!await input.canRead()) throw new VideoStudioError(`${label}不是能读的视频文件（支持 MP4、MOV、WebM）`)
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new VideoStudioError(`${label}片段里没有画面`)
    if (!await video.canDecode()) throw new VideoStudioError(`${label}片段的画面格式这台电脑解不开`)
    let audio = await input.getPrimaryAudioTrack()
    if (audio && !await audio.canDecode()) throw new VideoStudioError(`${label}片段的声音格式这台电脑解不开`)
    if (audio && await audio.computeDuration() <= await audio.getFirstTimestamp()) audio = null
    return { input, video, audio, start: await video.getFirstTimestamp(), end: await video.computeDuration() }
  } catch (error) {
    input.dispose()
    if (error instanceof VideoStudioError) throw error
    throw new VideoStudioError(`${label}不是能读的视频文件（支持 MP4、MOV、WebM）`)
  }
}

function captionMeasure(context: OffscreenCanvasRenderingContext2D) {
  return function measure(text: string, fontSize: number): number {
    context.font = videoStudioCaptionFont(fontSize)
    return context.measureText(text).width
  }
}

async function renderSegmentFrames(
  clip: ReadClip,
  segment: VideoStudioSegment,
  plan: VideoStudioRenderPlan,
  context: OffscreenCanvasRenderingContext2D,
  source: CanvasSource,
  onFrame: () => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  // The sink scales, crops or letterboxes each decoded frame into the output
  // box and applies the file's rotation metadata, so a phone clip shot upright
  // lands upright. Two pooled canvases are enough: each one is drawn onto the
  // output canvas before the next frame is requested.
  const sink = new CanvasSink(clip.video, { width: plan.width, height: plan.height, fit: plan.fit, poolSize: 2 })
  const caption = segment.caption ? layoutVideoStudioCaption(segment.caption, plan, captionMeasure(context)) : null
  const step = 1 / plan.frameRate
  let previous: WrappedCanvas | null = null
  let index = 0
  for await (const frame of sink.canvasesAtTimestamps(videoStudioSourceFrameTimes(segment, plan.frameRate))) {
    throwIfVideoStudioAborted(signal)
    const current: WrappedCanvas | null = frame ?? previous
    context.fillStyle = '#000000'
    context.fillRect(0, 0, plan.width, plan.height)
    if (current) context.drawImage(current.canvas, 0, 0, plan.width, plan.height)
    if (caption) paintVideoStudioCaption(context, caption)
    await source.add((segment.firstFrame + index) * step, step)
    previous = current
    index += 1
    onFrame()
  }
}

async function addSegmentAudio(
  clip: ReadClip,
  segment: VideoStudioSegment,
  plan: VideoStudioRenderPlan,
  assembler: VideoStudioPcmAssembler,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!clip.audio) return
  const samplesPerFrame = videoStudioSamplesPerFrame(plan.frameRate)
  const windowStart = segment.firstFrame * samplesPerFrame
  const windowEnd = (segment.firstFrame + segment.frameCount) * samplesPerFrame
  const sourceEnd = segment.sourceStart + segment.frameCount / plan.frameRate
  // 源片段上的时间加上这个差，就是成片上的时间。
  const outputOffset = segment.firstFrame / plan.frameRate - segment.sourceStart
  const sink = new AudioSampleSink(clip.audio)
  for await (const sample of sink.samples(segment.sourceStart, sourceEnd)) {
    try {
      throwIfVideoStudioAborted(signal)
      const data = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32' }) / 4)
      sample.copyTo(data, { planeIndex: 0, format: 'f32' })
      await assembler.add({
        data,
        frameCount: sample.numberOfFrames,
        channelCount: sample.numberOfChannels,
        sampleRate: sample.sampleRate,
        startTime: sample.timestamp + outputOffset,
      }, windowStart, windowEnd)
    } finally {
      sample.close()
    }
  }
}

/**
 * 把几段片段按顺序拼成一个 MP4：统一成同一个画面大小（裁边或补黑边）、烧进字幕、
 * 声音重采样后接在一起，没有声音的片段那一段是静音。整个成片在内存里组装，结束时
 * 一次交回字节。可以在页面里直接调，也可以放进后台线程（compose-worker.ts）。
 */
export async function composeVideoStudio(request: VideoStudioComposeRequest, hooks: VideoStudioComposeHooks = {}): Promise<VideoStudioComposeResult> {
  const { signal } = hooks
  const report = createProgressReporter(hooks.onProgress)
  throwIfVideoStudioAborted(signal)
  const clips: ReadClip[] = []
  let output: Output | null = null
  try {
    for (const [index, clip] of request.clips.entries()) {
      clips.push(await readClip(clip.data, index))
      throwIfVideoStudioAborted(signal)
      report('reading', clips.length / request.clips.length)
    }
    const plan = buildVideoStudioRenderPlan(clips.map((clip, index) => ({
      start: clip.start,
      end: clip.end,
      trimStart: request.clips[index].trimStart,
      trimEnd: request.clips[index].trimEnd,
      caption: request.clips[index].caption,
    })), request.options)
    const encoding = await chooseVideoStudioEncoding(
      { width: plan.width, height: plan.height, frameRate: plan.frameRate, sampleRate: videoStudioAudioSampleRate, numberOfChannels: videoStudioAudioChannels },
      clips.some((clip) => clip.audio),
      hooks.probe ?? mediabunnyEncodeProbe,
      request.encoding,
    )
    throwIfVideoStudioAborted(signal)

    const canvas = new OffscreenCanvas(plan.width, plan.height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new VideoStudioError('这台电脑没法在后台画画面，导不出视频')
    const target = new BufferTarget()
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const videoSource = new CanvasSource(canvas, { codec: encoding.video, quality: QUALITY_HIGH, keyFrameInterval: 2 })
    output.addVideoTrack(videoSource, { frameRate: plan.frameRate })
    const audioSource = encoding.audio ? new AudioSampleSource({ codec: encoding.audio, quality: QUALITY_HIGH }) : null
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()

    const assembler = audioSource
      ? createVideoStudioPcmAssembler({
        sampleRate: videoStudioAudioSampleRate,
        chunkFrames: videoStudioAudioSampleRate,
        async emit(chunk: VideoStudioPcmChunk) {
          const sample = new AudioSample({
            data: chunk.data,
            format: 'f32',
            numberOfChannels: videoStudioAudioChannels,
            sampleRate: videoStudioAudioSampleRate,
            timestamp: chunk.firstFrame / videoStudioAudioSampleRate,
          })
          try {
            await audioSource.add(sample)
          } finally {
            sample.close()
          }
        },
      })
      : null

    let framesDone = 0
    for (const segment of plan.segments) {
      const clip = clips[segment.clipIndex]
      await renderSegmentFrames(clip, segment, plan, context, videoSource, () => {
        framesDone += 1
        report('rendering', framesDone / plan.frameCount)
      }, signal)
      // 一段画面接着这一段的声音，两条轨在复用器里始终只差十几秒，不会一条跑到另一条前面太远。
      if (assembler) await addSegmentAudio(clip, segment, plan, assembler, signal)
    }
    if (assembler) await assembler.finish(plan.frameCount * videoStudioSamplesPerFrame(plan.frameRate))

    report('finishing', 0)
    throwIfVideoStudioAborted(signal)
    await output.finalize()
    const data = target.buffer
    if (!data) throw new VideoStudioError('成片没有写出来，请再试一次')
    const mimeType = await output.getMimeType()
    report('finishing', 1)
    return { data, mimeType, videoCodec: encoding.video, audioCodec: encoding.audio, width: plan.width, height: plan.height, duration: plan.duration }
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined)
    throw error
  } finally {
    for (const clip of clips) clip.input.dispose()
  }
}
