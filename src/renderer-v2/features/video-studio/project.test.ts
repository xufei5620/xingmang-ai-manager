import { describe, expect, it } from 'vitest'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import { aiVideoUnconfirmedSubmissionMessage } from '../../../../electron/ai-video-submission'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import {
  addVideoStudioShot,
  applyVideoStudioPlan,
  assignVideoStudioShotImages,
  buildVideoStudioCatalogs,
  buildVideoStudioClipRequest,
  buildVideoStudioImageRequest,
  clampVideoStudioSeconds,
  createVideoStudioProject,
  defaultVideoStudioSettings,
  finishVideoStudioShotDrawing,
  isVideoStudioShotDrawing,
  moveVideoStudioShot,
  removeVideoStudioMusic,
  removeVideoStudioShot,
  removeVideoStudioShotImage,
  restoreVideoStudioProject,
  selectVideoStudioVideoModel,
  serializeVideoStudioProject,
  setVideoStudioClipSound,
  setVideoStudioMusic,
  setVideoStudioShotSeconds,
  setVideoStudioShotTrim,
  settleVideoStudioModels,
  startVideoStudioShotDrawing,
  videoStudioCommonSeconds,
  videoStudioComposeCaptions,
  videoStudioComposeKey,
  videoStudioComposeSound,
  videoStudioImageSize,
  videoStudioPlainText,
  videoStudioReadyToCompose,
  videoStudioSecondsChoices,
  videoStudioShotImage,
  videoStudioShotProblem,
  videoStudioShotSeconds,
  videoStudioTotalSeconds,
  videoStudioTrimOptions,
  videoStudioUnconfirmedIndexes,
  withoutVideoStudioTrim,
  type VideoStudioProject,
} from './project'

function ids() {
  let next = 0
  return () => `shot-${++next}`
}

const clip = (letter: string): AiVideoClip => ({ assetId: letter.repeat(43), thumbnailUrl: `xingmang-asset://thumb/v2/video/${letter.repeat(43)}`, width: 720, height: 1280, durationSeconds: 6 })

function planned(): VideoStudioProject {
  return applyVideoStudioPlan(createVideoStudioProject(), {
    title: '回家的猫',
    shots: [{ prompt: '雨夜街头的橘猫', caption: '下雨了' }, { prompt: '橘猫穿过人群' }, { prompt: '橘猫跳上台阶', caption: '到家了' }],
  }, ids())
}

describe('video studio project', () => {
  it('turns a storyboard into shots and drops the previous film', () => {
    const before = { ...createVideoStudioProject(), exported: clip('e') }
    const project = applyVideoStudioPlan(before, { title: '回家的猫', shots: [{ prompt: '雨夜', caption: '下雨了' }, { prompt: '人群' }] }, ids())
    expect(project.title).toBe('回家的猫')
    expect(project.shots).toEqual([
      { id: 'shot-1', prompt: '雨夜', caption: '下雨了', status: 'idle' },
      { id: 'shot-2', prompt: '人群', caption: '', status: 'idle' },
    ])
    expect(project).not.toHaveProperty('exported')
  })

  it('moves, removes and adds shots within the storyboard limit', () => {
    const project = planned()
    expect(moveVideoStudioShot(project, 'shot-3', -1).shots.map((shot) => shot.id)).toEqual(['shot-1', 'shot-3', 'shot-2'])
    expect(moveVideoStudioShot(project, 'shot-1', -1)).toBe(project)
    expect(moveVideoStudioShot(project, 'shot-3', 1)).toBe(project)
    expect(removeVideoStudioShot(project, 'shot-2').shots.map((shot) => shot.id)).toEqual(['shot-1', 'shot-3'])
    const added = addVideoStudioShot(project, () => 'shot-new')
    expect(added.shots.at(-1)).toEqual({ id: 'shot-new', prompt: '', caption: '', status: 'idle' })
    let full = project
    for (let index = 0; index < 20; index += 1) full = addVideoStudioShot(full)
    expect(full.shots).toHaveLength(12)
  })

  it('says which shot still needs a description before anything is sent', () => {
    expect(videoStudioShotProblem({ id: 'a', prompt: '  ', caption: '', status: 'idle' }, 1)).toBe('第 2 个镜头还没写画面描述')
    expect(videoStudioShotProblem({ id: 'a', prompt: '画'.repeat(1_501), caption: '', status: 'idle' }, 0)).toBe('第 1 个镜头的画面描述太长了，删到 1500 个字以内')
    expect(videoStudioShotProblem({ id: 'a', prompt: '橘猫', caption: '', status: 'idle' }, 0)).toBeNull()
  })

  it('drops invisible control characters pasted into the text before it is sent, keeping line breaks and tabs', () => {
    expect(videoStudioPlainText(' 橘猫\u000b在雨里\u0000\n回家\t了\u007f ')).toBe('橘猫在雨里\n回家\t了')
    expect(videoStudioShotProblem({ id: 'a', prompt: '\u0001\u0002', caption: '', status: 'idle' }, 0)).toBe('第 1 个镜头还没写画面描述')
    const settings = { ...defaultVideoStudioSettings(), videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型' }
    expect(buildVideoStudioClipRequest(settings, { id: 'a', prompt: '橘猫\u000c回家', caption: '', status: 'idle' }, 'r1').prompt).toBe('橘猫回家')
  })

  it('asks Grok for its own frame sizes and MiniMax for its aspect ratio', () => {
    const shot = { id: 'a', prompt: '  橘猫  ', caption: '', status: 'idle' as const }
    const grok = { ...defaultVideoStudioSettings(), videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', secondsPerShot: 6 }
    expect(buildVideoStudioClipRequest(grok, shot, 'r1')).toEqual({ requestId: 'r1', group: '图片模型', model: 'grok-imagine-video-1.5', prompt: '橘猫', seconds: '6', width: 720, height: 1280 })
    expect(buildVideoStudioClipRequest({ ...grok, aspect: '16:9' }, shot, 'r2')).toMatchObject({ width: 1280, height: 720 })
    expect(buildVideoStudioClipRequest({ ...grok, aspect: '1:1' }, shot, 'r3')).toMatchObject({ width: 1024, height: 1024 })
    expect(buildVideoStudioClipRequest({ ...grok, videoModel: 'minimax-h3-fast', aspect: '16:9' }, shot, 'r4')).toEqual({
      requestId: 'r4', group: '图片模型', model: 'minimax-h3-fast', prompt: '橘猫', seconds: '6', mode: 't2va', resolution: '720p', aspectRatio: '16:9', promptOptimization: false,
    })
  })

  it('starts a shot from its picture: the first frame for Grok, image-to-video for MiniMax', () => {
    const image = videoStudioShotImage('i'.repeat(43))!
    const shot = { id: 'a', prompt: '橘猫', caption: '', image, status: 'idle' as const }
    const grok = { ...defaultVideoStudioSettings(), videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', secondsPerShot: 6 }
    expect(buildVideoStudioClipRequest(grok, shot, 'r1')).toEqual({
      requestId: 'r1', group: '图片模型', model: 'grok-imagine-video-1.5', prompt: '橘猫', seconds: '6', imageAssetIds: ['i'.repeat(43)], width: 720, height: 1280,
    })
    expect(buildVideoStudioClipRequest({ ...grok, videoModel: 'minimax-h3-base' }, shot, 'r2')).toEqual({
      requestId: 'r2', group: '图片模型', model: 'minimax-h3-base', prompt: '橘猫', seconds: '6', imageAssetIds: ['i'.repeat(43)], mode: 'i2va', resolution: '720p', aspectRatio: '9:16', promptOptimization: false,
    })
  })

  it('hands several picked pictures to the following shots that still have none, and keeps them through a new storyboard', () => {
    const project = planned()
    const busy = { ...project, shots: [project.shots[0], { ...project.shots[1], status: 'generating' as const, requestId: 'r' }, project.shots[2]] }
    const [a, b, c] = ['a', 'b', 'c'].map((letter) => letter.repeat(43))
    // The second shot is being generated, so its picture cannot change under it; the extra picture has nowhere to go.
    const assigned = assignVideoStudioShotImages(busy, 'shot-1', [a, b, c, '../not-an-id'])
    expect(assigned.shots.map((shot) => shot.image?.assetId)).toEqual([a, undefined, b])
    expect(assigned.shots[0].image).toEqual({ assetId: a, url: `xingmang-asset://image/${a}` })
    // Changing one shot's picture never touches a later shot that already has one.
    expect(assignVideoStudioShotImages(assigned, 'shot-1', [c, a]).shots.map((shot) => shot.image?.assetId)).toEqual([c, undefined, b])
    expect(assignVideoStudioShotImages(assigned, 'shot-2', [c])).toBe(assigned)
    expect(assignVideoStudioShotImages(assigned, 'missing', [c])).toBe(assigned)
    expect(assignVideoStudioShotImages(assigned, 'shot-1', [])).toBe(assigned)

    expect(removeVideoStudioShotImage(assigned, 'shot-3').shots[2]).not.toHaveProperty('image')
    expect(removeVideoStudioShotImage(assigned, 'shot-2')).toBe(assigned)

    const replanned = applyVideoStudioPlan(assigned, { title: '新的', shots: [{ prompt: '一' }, { prompt: '二' }] }, () => 'new')
    expect(replanned.shots.map((shot) => shot.image?.assetId)).toEqual([a, undefined])
  })

  it('offers only the clip lengths a video model can make and moves to the nearest one', () => {
    expect(videoStudioSecondsChoices('grok-imagine-video')).toEqual([3, 4, 5, 6, 8, 10, 12, 15])
    expect(videoStudioSecondsChoices('minimax-h3-base')).toEqual([5, 6, 8, 10, 12, 15])
    expect(clampVideoStudioSeconds(3, 'minimax-h3-base')).toBe(5)
    expect(clampVideoStudioSeconds(9, 'grok-imagine-video')).toBe(8)
    expect(clampVideoStudioSeconds(6, 'gpt-5.6-sol')).toBe(6)
  })

  it('lists text, video and image models from every prepared group and settles the defaults', () => {
    const groups = [{ name: 'GPT', recommended: true, ratio: 1 }, { name: '图片模型', ratio: 1 }, { name: '其他', ratio: 0.5 }]
    const preparations = {
      GPT: { phase: 'ready' as const, models: ['gpt-5.6-sol', 'gpt-5.4'] },
      图片模型: { phase: 'ready' as const, models: ['gpt-image-2', 'minimax-h3-base', 'grok-imagine-video-1.5', 'sora-2'] },
      其他: { phase: 'ready' as const, models: ['grok-imagine-video-1.5', 'deepseek-v4'] },
    }
    const catalogs = buildVideoStudioCatalogs(groups, preparations)
    expect(catalogs.text.map((entry) => entry.model)).toEqual(['gpt-5.6-sol', 'gpt-5.4', 'deepseek-v4'])
    expect(catalogs.video).toEqual([{ model: 'minimax-h3-base', groups: ['图片模型'] }, { model: 'grok-imagine-video-1.5', groups: ['图片模型', '其他'] }])
    // Video models never show up as picture models, even though the chat catalog files both under images.
    expect(catalogs.image).toEqual([{ model: 'gpt-image-2', groups: ['图片模型'] }])
    const context = { groups, site: 'solov' as const, settled: true }
    expect(settleVideoStudioModels({ ...defaultVideoStudioSettings(), secondsPerShot: 3 }, catalogs, context)).toEqual({
      textModel: 'gpt-5.6-sol', textGroup: 'GPT', videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', imageModel: 'gpt-image-2', imageGroup: '图片模型', secondsPerShot: 3,
    })
    // A remembered MiniMax model stays, and the clip length moves up to what it can make.
    expect(settleVideoStudioModels({ ...defaultVideoStudioSettings(), videoModel: 'minimax-h3-base', secondsPerShot: 3 }, catalogs, context)).toMatchObject({ videoModel: 'minimax-h3-base', videoGroup: '图片模型', secondsPerShot: 5 })
    // While groups are still loading a missing remembered model is kept rather than replaced.
    expect(settleVideoStudioModels({ ...defaultVideoStudioSettings(), textModel: 'claude-x', textGroup: 'Claude' }, catalogs, { ...context, settled: false })).toMatchObject({ textModel: 'claude-x', textGroup: 'Claude' })
  })

  it('draws a shot picture in the frame the film uses, at the model default quality', () => {
    const shot = { id: 'a', prompt: '橘猫\u0007在雨里', caption: '', status: 'idle' as const }
    const request = (imageModel: string, aspect: '16:9' | '9:16' | '1:1') => buildVideoStudioImageRequest({ ...defaultVideoStudioSettings(), imageModel, imageGroup: '图片模型', aspect }, shot, 'd1')
    expect(request('gpt-image-2', '9:16')).toEqual({ requestId: 'd1', group: '图片模型', model: 'gpt-image-2', prompt: '橘猫在雨里', size: '720x1280' })
    expect(request('gpt-image-2', '16:9').size).toBe('1280x720')
    expect(request('gpt-image-2', '1:1').size).toBe('720x720')
    // Jimeng stops at 1024 on the long side; both sides stay multiples of 16.
    expect(request('jimeng_high_aes_general_v21_L', '9:16').size).toBe('576x1024')
    // Fixed-size models get the size whose shape is closest to the frame.
    expect(request('gemini-3.1-flash-image', '9:16').size).toBe('720x1280')
    expect(request('gemini-3.1-flash-image', '1:1').size).toBe('1024x1024')
    expect(request('gpt-image-1', '9:16').size).toBe('1024x1536')
    expect(request('gpt-image-1', '16:9').size).toBe('1536x1024')
    expect(request('grok-imagine-image', '16:9').size).toBe('auto')
    // A model the page cannot read is sent without a size and left to the main process to refuse.
    expect(request('not-a-picture-model', '9:16')).not.toHaveProperty('size')
    expect(request('gpt-image-2', '9:16')).not.toHaveProperty('quality')
    expect(videoStudioImageSize({ kind: 'allow-list', values: ['odd'], default: '512x512' }, '16:9')).toBe('512x512')
    expect(videoStudioImageSize({ kind: 'divisible', divisor: 64, min: 768, max: 4096, default: '1024x1024' }, '9:16')).toBe('768x1280')
  })

  it('puts a drawn picture only on the shot still waiting for that drawing', () => {
    const project = planned()
    const first = videoStudioShotImage('a'.repeat(43))!
    const withImage = { ...project, shots: [{ ...project.shots[0], image: first, drawError: '上次没画出来' }, { ...project.shots[1], status: 'generating' as const, requestId: 'r' }, project.shots[2]] }
    const started = startVideoStudioShotDrawing(withImage, 'shot-1', 'd1')
    expect(started.shots[0]).toMatchObject({ drawing: 'd1', image: first })
    expect(started.shots[0]).not.toHaveProperty('drawError')
    expect(isVideoStudioShotDrawing(started.shots[0])).toBe(true)
    // A shot already drawing, or one making its clip, does not start another drawing.
    expect(startVideoStudioShotDrawing(started, 'shot-1', 'd2')).toBe(started)
    expect(startVideoStudioShotDrawing(started, 'shot-2', 'd3')).toBe(started)
    expect(startVideoStudioShotDrawing(started, 'missing', 'd4')).toBe(started)

    // A late answer for an older drawing never lands.
    expect(finishVideoStudioShotDrawing(started, 'shot-1', 'old', { assetId: 'b'.repeat(43) })).toBe(started)
    const drawn = finishVideoStudioShotDrawing(started, 'shot-1', 'd1', { assetId: 'b'.repeat(43) })
    expect(drawn.shots[0].image).toEqual({ assetId: 'b'.repeat(43), url: `xingmang-asset://image/${'b'.repeat(43)}` })
    expect(drawn.shots[0]).not.toHaveProperty('drawing')
    expect(isVideoStudioShotDrawing(drawn.shots[0])).toBe(false)

    const failed = finishVideoStudioShotDrawing(startVideoStudioShotDrawing(drawn, 'shot-1', 'd5'), 'shot-1', 'd5', { error: '没有收到生成的图片' })
    expect(failed.shots[0]).toMatchObject({ image: drawn.shots[0].image, drawError: '没有收到生成的图片' })
    expect(failed.shots[0]).not.toHaveProperty('drawing')
    const stopped = finishVideoStudioShotDrawing(startVideoStudioShotDrawing(failed, 'shot-1', 'd6'), 'shot-1', 'd6', 'stopped')
    expect(stopped.shots[0].image).toEqual(drawn.shots[0].image)
    expect(stopped.shots[0]).not.toHaveProperty('drawing')
    expect(stopped.shots[0]).not.toHaveProperty('drawError')

    // Drawing state lives only while the page is open.
    const stored = serializeVideoStudioProject(startVideoStudioShotDrawing(failed, 'shot-1', 'd7'))
    expect(JSON.stringify(stored)).not.toMatch(/d7|drawError|没有收到生成的图片/)
  })

  it('gives a shot its own length, lets the rest follow the shot length and moves both to what a new video model can make', () => {
    const base = planned()
    const project: VideoStudioProject = { ...base, settings: { ...base.settings, videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型' } }
    expect(project.shots.map((shot) => videoStudioShotSeconds(shot, project.settings))).toEqual([6, 6, 6])
    expect(videoStudioCommonSeconds(project)).toBe(6)
    const longer = setVideoStudioShotSeconds(project, 'shot-2', 10)
    expect(longer.shots[1].seconds).toBe(10)
    expect(buildVideoStudioClipRequest(longer.settings, longer.shots[1], 'r').seconds).toBe('10')
    expect(buildVideoStudioClipRequest(longer.settings, longer.shots[0], 'r').seconds).toBe('6')
    expect(videoStudioCommonSeconds(longer)).toBeNull()
    expect(videoStudioCommonSeconds(longer, [longer.shots[0], longer.shots[2]])).toBe(6)
    expect(videoStudioTotalSeconds(longer)).toBe(22)
    // Picking the shot length again means following it, so a later change of the shot length carries the shot along.
    expect(setVideoStudioShotSeconds(longer, 'shot-2', 6).shots[1]).not.toHaveProperty('seconds')
    // A length the model cannot make, the same length, or a shot already on its way change nothing.
    expect(setVideoStudioShotSeconds(longer, 'shot-2', 7)).toBe(longer)
    expect(setVideoStudioShotSeconds(longer, 'shot-2', 10)).toBe(longer)
    const queued = { ...longer, shots: longer.shots.map((shot, index) => index === 0 ? { ...shot, status: 'queued' as const } : shot) }
    expect(setVideoStudioShotSeconds(queued, 'shot-1', 8)).toBe(queued)

    // MiniMax makes 5 seconds at least: a 3 second shot moves up, and one landing on the shot length follows it again.
    const short = setVideoStudioShotSeconds(setVideoStudioShotSeconds(longer, 'shot-1', 3), 'shot-3', 5)
    const minimax = selectVideoStudioVideoModel(short, 'minimax-h3-base', '图片模型')
    expect(minimax.settings).toMatchObject({ videoModel: 'minimax-h3-base', videoGroup: '图片模型', secondsPerShot: 6 })
    expect(minimax.shots.map((shot) => shot.seconds)).toEqual([5, 10, 5])
    const fromThree = selectVideoStudioVideoModel({ ...short, settings: { ...short.settings, secondsPerShot: 3 } }, 'minimax-h3-base', '图片模型')
    expect(fromThree.settings.secondsPerShot).toBe(5)
    expect(fromThree.shots.map((shot) => shot.seconds)).toEqual([undefined, 10, undefined])
    // A length remembered from before the model changed is still read as one the model can make.
    expect(videoStudioShotSeconds({ seconds: 3 }, minimax.settings)).toBe(5)
  })

  it('stores a shot length of its own and reads back only one it can trust', () => {
    const project = setVideoStudioShotSeconds({ ...planned(), settings: { ...planned().settings, videoModel: 'grok-imagine-video-1.5' } }, 'shot-1', 10)
    const raw = JSON.parse(JSON.stringify(serializeVideoStudioProject(project)))
    expect(raw.shots[0].seconds).toBe(10)
    expect(raw.shots[1]).not.toHaveProperty('seconds')
    expect(restoreVideoStudioProject(raw)!.shots[0].seconds).toBe(10)
    for (const seconds of [99, 6.5, '10', 6]) {
      raw.shots[0].seconds = seconds
      expect(restoreVideoStudioProject(raw)!.shots[0]).not.toHaveProperty('seconds')
    }
  })

  it('composes only when every shot has a clip, and burns captions only when they are on', () => {
    const project = planned()
    expect(videoStudioReadyToCompose(project)).toBe(false)
    const done: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('abc'[index]), status: 'done' })) }
    expect(videoStudioReadyToCompose(done)).toBe(true)
    expect(videoStudioReadyToCompose({ ...done, shots: done.shots.map((shot, index) => index === 1 ? { ...shot, status: 'generating' } : shot) })).toBe(false)
    expect(videoStudioComposeCaptions(done)).toEqual(['下雨了', '', '到家了'])
    expect(videoStudioComposeCaptions({ ...done, settings: { ...done.settings, captions: false } })).toEqual(['', '', ''])
  })

  it('changes the compose key with anything that ends up in the film and nothing else', () => {
    const project = planned()
    const done: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('abc'[index]), status: 'done' })) }
    const key = videoStudioComposeKey(done)
    expect(videoStudioComposeKey({ ...done, title: '另一个名字', shots: done.shots.map((shot) => ({ ...shot, prompt: `${shot.prompt}，改过` })) })).toBe(key)
    expect(videoStudioComposeKey(moveVideoStudioShot(done, 'shot-2', 1))).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, shots: done.shots.map((shot, index) => index === 0 ? { ...shot, clip: clip('z') } : shot) })).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, shots: done.shots.map((shot, index) => index === 0 ? { ...shot, caption: '雨停了' } : shot) })).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, settings: { ...done.settings, captions: false } })).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, settings: { ...done.settings, fit: 'contain' } })).not.toBe(key)
    expect(videoStudioComposeKey(applyVideoStudioPlan(done, { title: '新的', shots: [{ prompt: '新镜头' }] }, ids()))).not.toBe(key)
    expect(videoStudioComposeKey(setVideoStudioShotTrim(done, 'shot-1', 'start', 1))).not.toBe(key)
    expect(videoStudioComposeKey(setVideoStudioShotTrim(done, 'shot-1', 'end', 0.5))).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, settings: { ...done.settings, transition: 'fade' } })).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, settings: { ...done.settings, fadeOut: true } })).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, settings: { ...done.settings, captionSize: 'large' } })).not.toBe(key)
    expect(videoStudioComposeKey({ ...done, settings: { ...done.settings, captionPosition: 'top' } })).not.toBe(key)
  })

  it('cuts straight between shots without a fade at the end unless asked, also for projects saved before the choice existed', () => {
    expect(defaultVideoStudioSettings()).toMatchObject({ transition: 'cut', fadeOut: false })
    const stored = JSON.parse(JSON.stringify(serializeVideoStudioProject(planned())))
    delete stored.settings.transition
    delete stored.settings.fadeOut
    expect(restoreVideoStudioProject(stored)!.settings).toMatchObject({ transition: 'cut', fadeOut: false })
    expect(restoreVideoStudioProject({ ...stored, settings: { ...stored.settings, transition: 'fade', fadeOut: true } })!.settings).toMatchObject({ transition: 'fade', fadeOut: true })
    expect(restoreVideoStudioProject({ ...stored, settings: { ...stored.settings, transition: 'wipe', fadeOut: 'yes' } })!.settings).toMatchObject({ transition: 'cut', fadeOut: false })
  })

  it('prints captions medium-sized at the bottom unless asked, also for projects saved before the choice existed', () => {
    expect(defaultVideoStudioSettings()).toMatchObject({ captionSize: 'medium', captionPosition: 'bottom' })
    const stored = JSON.parse(JSON.stringify(serializeVideoStudioProject(planned())))
    delete stored.settings.captionSize
    delete stored.settings.captionPosition
    expect(restoreVideoStudioProject(stored)!.settings).toMatchObject({ captionSize: 'medium', captionPosition: 'bottom' })
    expect(restoreVideoStudioProject({ ...stored, settings: { ...stored.settings, captionSize: 'small', captionPosition: 'middle' } })!.settings).toMatchObject({ captionSize: 'small', captionPosition: 'middle' })
    expect(restoreVideoStudioProject({ ...stored, settings: { ...stored.settings, captionSize: 'huge', captionPosition: 'left' } })!.settings).toMatchObject({ captionSize: 'medium', captionPosition: 'bottom' })
  })

  it('trims a clip by a few fixed steps, keeps at least a second of it and lets go of the film it no longer matches', () => {
    const project = planned()
    const done: VideoStudioProject = {
      ...project,
      shots: [{ ...project.shots[0], clip: clip('a'), status: 'done' }, { ...project.shots[1], clip: { ...clip('b'), durationSeconds: 2.5 }, status: 'done' }, project.shots[2]],
      exported: clip('f'),
    }
    expect(videoStudioTrimOptions(done.shots[0], 'start', 6)).toEqual([0, 0.5, 1, 1.5, 2, 3])
    const trimmed = setVideoStudioShotTrim(done, 'shot-1', 'start', 1)
    expect(trimmed.shots[0]).toMatchObject({ trimStart: 1 })
    expect(trimmed.shots[0]).not.toHaveProperty('trimEnd')
    expect(trimmed.exported).toBeUndefined()
    // Back to zero drops the field instead of storing a zero.
    expect(setVideoStudioShotTrim(trimmed, 'shot-1', 'start', 0).shots[0]).not.toHaveProperty('trimStart')
    // The same value, a value off the list, a shot without a clip or one being regenerated change nothing.
    expect(setVideoStudioShotTrim(trimmed, 'shot-1', 'start', 1)).toBe(trimmed)
    expect(setVideoStudioShotTrim(trimmed, 'shot-1', 'start', 0.7)).toBe(trimmed)
    expect(setVideoStudioShotTrim(trimmed, 'shot-3', 'start', 1)).toBe(trimmed)
    const busy = { ...trimmed, shots: trimmed.shots.map((shot, index) => index === 0 ? { ...shot, status: 'generating' as const, requestId: 'r' } : shot) }
    expect(setVideoStudioShotTrim(busy, 'shot-1', 'end', 1)).toBe(busy)

    // A 2.5 second clip keeps at least a second: with half a second off the end, at most a second comes off the start.
    const short = setVideoStudioShotTrim(done, 'shot-2', 'end', 0.5)
    expect(videoStudioTrimOptions(short.shots[1], 'start', 6)).toEqual([0, 0.5, 1])
    expect(setVideoStudioShotTrim(short, 'shot-2', 'start', 1.5)).toBe(short)
    // Without a known length the shot length stands in.
    expect(videoStudioTrimOptions({ clip: { ...clip('c'), durationSeconds: undefined } }, 'end', 3)).toEqual([0, 0.5, 1, 1.5, 2])
    // The value already chosen always stays on the list, so the menu never shows a blank.
    expect(videoStudioTrimOptions({ clip: { ...clip('c'), durationSeconds: 1 }, trimEnd: 2 }, 'end', 6)).toEqual([0, 2])

    expect(videoStudioTotalSeconds(done)).toBe(18)
    expect(videoStudioTotalSeconds(setVideoStudioShotTrim(short, 'shot-1', 'start', 1))).toBe(17)
    expect(withoutVideoStudioTrim({ id: 'x', trimStart: 1, trimEnd: 0.5 })).toEqual({ id: 'x' })
  })

  it('stores how much of each clip is trimmed and reads back only trims it can trust', () => {
    const project = planned()
    const done: VideoStudioProject = { ...project, shots: [{ ...project.shots[0], clip: clip('a'), status: 'done' }, ...project.shots.slice(1)] }
    const trimmed = setVideoStudioShotTrim(setVideoStudioShotTrim(done, 'shot-1', 'start', 1), 'shot-1', 'end', 0.5)
    const stored = serializeVideoStudioProject(trimmed)
    expect(restoreVideoStudioProject(JSON.parse(JSON.stringify(stored)))!.shots[0]).toMatchObject({ trimStart: 1, trimEnd: 0.5 })
    const raw = JSON.parse(JSON.stringify(stored))
    raw.shots[0].trimStart = 0.7
    raw.shots[0].trimEnd = '1'
    raw.shots[1].trimStart = 1
    const restored = restoreVideoStudioProject(raw)!
    expect(restored.shots[0]).not.toHaveProperty('trimStart')
    expect(restored.shots[0]).not.toHaveProperty('trimEnd')
    // A trim without a clip, or trims that leave less than a second, are dropped as a whole.
    expect(restored.shots[1]).not.toHaveProperty('trimStart')
    raw.shots[0].trimStart = 3
    raw.shots[0].trimEnd = 3
    expect(restoreVideoStudioProject(raw)!.shots[0]).not.toHaveProperty('trimStart')
  })

  it('stores the storyboard, clip ids and the requests still out, but not their progress', () => {
    const project = planned()
    const running: VideoStudioProject = {
      ...project,
      shots: [
        { ...project.shots[0], clip: clip('a'), status: 'generating', requestId: 'again', stage: 'downloading', progress: 90 },
        { ...project.shots[1], status: 'generating', requestId: 'r', progress: 40, delayed: true },
        { ...project.shots[2], status: 'queued' },
      ],
      exported: clip('z'),
    }
    const restored = restoreVideoStudioProject(JSON.parse(JSON.stringify(serializeVideoStudioProject(running))))
    // A request that went out is picked back up when the page reopens (useVideoStudio); one only queued here was never sent or paid for.
    expect(restored?.shots).toEqual([
      { id: 'shot-1', prompt: '雨夜街头的橘猫', caption: '下雨了', clip: clip('a'), requestId: 'again', status: 'generating' },
      { id: 'shot-2', prompt: '橘猫穿过人群', caption: '', requestId: 'r', status: 'generating' },
      { id: 'shot-3', prompt: '橘猫跳上台阶', caption: '到家了', status: 'idle' },
    ])
    expect(restored?.exported).toEqual(clip('z'))
    expect(restored?.title).toBe('回家的猫')
  })

  // #1489 N2：提交没收到答复的那一镜，重开以后不能变回「还没生成」让「生成剩下的」再付一次钱。
  it('keeps a shot whose submission went unanswered failed with its warning after the page reopens', () => {
    const project = planned()
    const unclear: VideoStudioProject = {
      ...project,
      shots: [
        { ...project.shots[0], status: 'failed', requestId: 'lost', unconfirmed: true, error: aiVideoUnconfirmedSubmissionMessage },
        { ...project.shots[1], clip: clip('b'), status: 'failed', requestId: 'lost-again', unconfirmed: true, error: aiVideoUnconfirmedSubmissionMessage },
        { ...project.shots[2], status: 'failed', requestId: 'slow', error: '暂时查不到生成进度' },
      ],
    }
    const restored = restoreVideoStudioProject(JSON.parse(JSON.stringify(serializeVideoStudioProject(unclear))))
    // There is no task id to fetch it by, so it is not picked back up; the warning stays until the person decides to pay again.
    expect(restored?.shots).toEqual([
      { id: 'shot-1', prompt: '雨夜街头的橘猫', caption: '下雨了', requestId: 'lost', unconfirmed: true, status: 'failed', error: aiVideoUnconfirmedSubmissionMessage },
      { id: 'shot-2', prompt: '橘猫穿过人群', caption: '', clip: clip('b'), requestId: 'lost-again', unconfirmed: true, status: 'failed', error: aiVideoUnconfirmedSubmissionMessage },
      { id: 'shot-3', prompt: '橘猫跳上台阶', caption: '到家了', requestId: 'slow', status: 'generating' },
    ])
    expect(videoStudioUnconfirmedIndexes(restored!, ['shot-3', 'shot-2', 'shot-1'])).toEqual([0, 1])
    expect(videoStudioUnconfirmedIndexes(restored!, ['shot-3'])).toEqual([])

    // Being paid for again under the same id: reopening picks it back up, and the main process answers for the earlier attempt.
    const retrying = restoreVideoStudioProject(JSON.parse(JSON.stringify(serializeVideoStudioProject({
      ...unclear, shots: [{ ...unclear.shots[0], status: 'generating', error: undefined }],
    }))))
    expect(retrying?.shots).toEqual([{ id: 'shot-1', prompt: '雨夜街头的橘猫', caption: '下雨了', requestId: 'lost', status: 'generating' }])

    // The mark means nothing without the request it belongs to.
    const orphan = restoreVideoStudioProject({ version: 1, settings: defaultVideoStudioSettings(), title: '', shots: [{ id: 'x', prompt: '一', caption: '', unconfirmed: true }] })
    expect(orphan?.shots).toEqual([{ id: 'x', prompt: '一', caption: '', status: 'idle' }])
  })

  it('reads back a damaged record without trusting it', () => {
    expect(restoreVideoStudioProject(null)).toBeNull()
    expect(restoreVideoStudioProject({ version: 2, settings: {} })).toBeNull()
    const restored = restoreVideoStudioProject({
      version: 1,
      settings: { idea: 7, shotCount: 99, secondsPerShot: 0, aspect: '4:3', captions: 'yes', textModel: 'bad\nmodel', resolution: 4320, fit: 'stretch' },
      title: '题'.repeat(100),
      shots: [
        { id: 'same', prompt: '一', clip: { assetId: 'a'.repeat(43), thumbnailUrl: 'https://evil.example/x.png' } },
        { id: 'same', prompt: '二', clip: { assetId: 'b'.repeat(43), thumbnailUrl: `xingmang-asset://thumb/v2/video/${'c'.repeat(43)}` } },
        'not a shot',
        { id: '../../x', prompt: 3, requestId: '../../secret' },
      ],
      exported: { assetId: '../secret', thumbnailUrl: 'xingmang-asset://thumb/v2/video/x' },
    }, ids())
    expect(restored?.settings).toEqual(defaultVideoStudioSettings())
    expect(restored?.title).toHaveLength(40)
    expect(restored?.shots).toEqual([
      { id: 'same', prompt: '一', caption: '', status: 'idle' },
      { id: 'shot-1', prompt: '二', caption: '', status: 'idle' },
      { id: 'shot-2', prompt: '', caption: '', status: 'idle' },
    ])
    expect(restored).not.toHaveProperty('exported')
  })

  it('points clips saved under an older thumbnail version at the current one, so old projects keep their pictures', () => {
    const older = (letter: string) => ({ ...clip(letter), thumbnailUrl: `xingmang-asset://thumb/v1/video/${letter.repeat(43)}` })
    const restored = restoreVideoStudioProject({
      version: 1,
      settings: defaultVideoStudioSettings(),
      title: '',
      shots: [{ id: 'old', prompt: '旧镜头', caption: '', clip: older('a') }],
      exported: older('z'),
    })
    expect(restored?.shots[0]?.clip).toEqual({ ...clip('a'), thumbnailUrl: assetThumbnailUrl('a'.repeat(43), 'video') })
    expect(restored?.exported).toEqual({ ...clip('z'), thumbnailUrl: assetThumbnailUrl('z'.repeat(43), 'video') })
    expect(restored?.exported?.thumbnailUrl).not.toContain('/v1/')
  })

  it('stores only the id of a shot picture and rebuilds its address when reading it back', () => {
    const project = planned()
    const withImage = { ...project, shots: [{ ...project.shots[0], image: videoStudioShotImage('p'.repeat(43))! }, ...project.shots.slice(1)] }
    const stored = JSON.parse(JSON.stringify(serializeVideoStudioProject(withImage)))
    expect(stored.shots[0].image).toEqual({ assetId: 'p'.repeat(43) })
    expect(restoreVideoStudioProject(stored)?.shots[0].image).toEqual({ assetId: 'p'.repeat(43), url: `xingmang-asset://image/${'p'.repeat(43)}` })
    const tampered = restoreVideoStudioProject({
      version: 1, settings: defaultVideoStudioSettings(), title: '',
      shots: [{ id: 'x', prompt: '一', caption: '', image: { assetId: '../../secret', url: 'https://evil.example/a.png' } }, { id: 'y', prompt: '二', caption: '', image: 'p'.repeat(43) }],
    })
    expect(tampered?.shots.map((shot) => shot.image)).toEqual([undefined, undefined])
  })

  it('starts a song with the clip sound turned down, keeps that choice on a new song and lets go of the film it no longer matches', () => {
    const film = { ...planned(), exported: clip('f') }
    expect(videoStudioComposeSound(film)).toEqual({})
    const song = { assetId: 'm'.repeat(43), name: '晴天', durationSeconds: 269 }
    const withSong = setVideoStudioMusic(film, song)
    expect(withSong.music).toEqual({ ...song, clipSound: 'quiet' })
    expect(withSong.exported).toBeUndefined()
    expect(videoStudioComposeSound(withSong)).toEqual({ music: { assetId: 'm'.repeat(43), gain: 0.7 }, clipGain: 0.3 })

    const off = setVideoStudioClipSound(withSong, 'off')
    expect(videoStudioComposeSound(off)).toEqual({ music: { assetId: 'm'.repeat(43), gain: 0.9 }, clipGain: 0 })
    expect(videoStudioComposeSound(setVideoStudioClipSound(off, 'normal'))).toEqual({ music: { assetId: 'm'.repeat(43), gain: 0.3 }, clipGain: 1 })
    expect(setVideoStudioMusic(off, { assetId: 'n'.repeat(43), name: '七里香' }).music).toEqual({ assetId: 'n'.repeat(43), name: '七里香', clipSound: 'off' })

    // Nothing to change leaves the film in place.
    const stored = { ...off, exported: clip('f') }
    expect(setVideoStudioClipSound(stored, 'off')).toBe(stored)
    expect(setVideoStudioClipSound(film, 'off')).toBe(film)
    expect(removeVideoStudioMusic(film)).toBe(film)
    expect(removeVideoStudioMusic(stored)).toEqual({ ...stored, music: undefined, exported: undefined })
  })

  it('changes the compose key with the song and how loud the clips play under it', () => {
    const project = planned()
    const done: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('abc'[index]), status: 'done' })) }
    const withSong = setVideoStudioMusic(done, { assetId: 'm'.repeat(43), name: '晴天' })
    const key = videoStudioComposeKey(withSong)
    expect(videoStudioComposeKey(done)).not.toBe(key)
    expect(videoStudioComposeKey({ ...withSong, music: { ...withSong.music!, name: '改了名' } })).toBe(key)
    expect(videoStudioComposeKey(setVideoStudioClipSound(withSong, 'off'))).not.toBe(key)
    expect(videoStudioComposeKey(setVideoStudioMusic(withSong, { assetId: 'n'.repeat(43), name: '晴天' }))).not.toBe(key)
  })

  it('stores the chosen song by id and reads back only a song it can trust', () => {
    const withSong = setVideoStudioClipSound(setVideoStudioMusic(planned(), { assetId: 'm'.repeat(43), name: '晴天', durationSeconds: 269 }), 'normal')
    const stored = JSON.parse(JSON.stringify(serializeVideoStudioProject(withSong)))
    expect(stored.music).toEqual({ assetId: 'm'.repeat(43), name: '晴天', durationSeconds: 269, clipSound: 'normal' })
    expect(restoreVideoStudioProject(stored)?.music).toEqual(withSong.music)
    expect(restoreVideoStudioProject(serializeVideoStudioProject(planned()))?.music).toBeUndefined()

    function restoredMusic(music: unknown) {
      return restoreVideoStudioProject({ version: 1, settings: defaultVideoStudioSettings(), title: '', shots: [], music })?.music
    }
    expect(restoredMusic({ assetId: '../../secret', name: '晴天', clipSound: 'quiet' })).toBeUndefined()
    expect(restoredMusic({ assetId: 'm'.repeat(43), name: '\u0007 ', clipSound: 'quiet' })).toBeUndefined()
    expect(restoredMusic('m'.repeat(43))).toBeUndefined()
    expect(restoredMusic({ assetId: 'm'.repeat(43), name: `晴\n天${'长'.repeat(200)}`, durationSeconds: -3, clipSound: 'loud' }))
      .toEqual({ assetId: 'm'.repeat(43), name: `晴 天${'长'.repeat(77)}`, clipSound: 'quiet' })
  })
})
