import { describe, expect, it } from 'vitest'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import { aiVideoUnconfirmedSubmissionMessage } from '../../../../electron/ai-video-submission'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import { appendVideoStudioClip, assignVideoStudioShotClip, buildVideoClipRequest, canAddVideoStudioShot, createVideoStudioProjectFromClip, createVideoStudioProjectFromClips, removeVideoStudioShotClip, videoStudioUnconfirmedWarning, withoutVideoStudioBorrowed } from './project'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
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
  isVideoStudioProjectEmpty,
  maxVideoStudioDrafts,
  moveVideoStudioShot,
  removeVideoStudioMusic,
  removeVideoStudioShot,
  removeVideoStudioShotImage,
  restoreVideoStudioDrafts,
  restoreVideoStudioProject,
  selectVideoStudioVideoModel,
  serializeVideoStudioProject,
  setVideoStudioClipSound,
  setVideoStudioMusic,
  setVideoStudioShotSeconds,
  setVideoStudioShotTrim,
  changeVideoStudioSettings,
  settleVideoStudioModels,
  startVideoStudioShotDrawing,
  videoStudioCommonSeconds,
  videoStudioComposeCaptions,
  videoStudioComposeKey,
  videoStudioComposeSound,
  videoStudioDraftName,
  videoStudioDraftProgress,
  videoStudioDraftsStorageKey,
  videoStudioImageModelChoice,
  videoStudioImageOptions,
  videoStudioImageSettingsToShare,
  videoStudioImageSize,
  videoStudioPlainText,
  videoStudioReadyToCompose,
  videoStudioSecondsChoices,
  videoStudioShotImage,
  videoStudioShotProblem,
  videoStudioShotSeconds,
  videoStudioStorageKey,
  videoStudioTotalSeconds,
  videoStudioTrimOptions,
  videoStudioUnconfirmedIndexes,
  withoutVideoStudioTrim,
  type VideoStudioDraft,
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
    expect(videoStudioShotProblem({ id: 'a', prompt: '  ', caption: '', status: 'idle' }, 1)).toBe('第 2 个镜头尚未填写画面描述')
    expect(videoStudioShotProblem({ id: 'a', prompt: '画'.repeat(1_501), caption: '', status: 'idle' }, 0)).toBe('第 1 个镜头的画面描述过长，请删减至 1500 个字以内')
    expect(videoStudioShotProblem({ id: 'a', prompt: '橘猫', caption: '', status: 'idle' }, 0)).toBeNull()
  })

  it('drops invisible control characters pasted into the text before it is sent, keeping line breaks and tabs', () => {
    expect(videoStudioPlainText(' 橘猫\u000b在雨里\u0000\n回家\t了\u007f ')).toBe('橘猫在雨里\n回家\t了')
    expect(videoStudioShotProblem({ id: 'a', prompt: '\u0001\u0002', caption: '', status: 'idle' }, 0)).toBe('第 1 个镜头尚未填写画面描述')
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

  it('builds the picture request the way the chat composer does', () => {
    const draft = { prompt: '橘猫\u0007在雨里', model: 'gpt-image-2', group: '图片模型', size: '720x1280', quality: 'medium' as const, imageResolution: '2K' as const }
    expect(buildVideoStudioImageRequest(draft, 'd1')).toEqual({ requestId: 'd1', group: '图片模型', model: 'gpt-image-2', prompt: '橘猫在雨里', size: '720x1280', quality: 'medium', imageResolution: '2K' })
    // A model with no quality tiers is sent without one.
    expect(buildVideoStudioImageRequest({ ...draft, model: 'gemini-3.1-flash-image' }, 'd2')).not.toHaveProperty('quality')
    // Reference pictures go along only when there are some.
    expect(buildVideoStudioImageRequest(draft, 'd3')).not.toHaveProperty('sourceAssetIds')
    expect(buildVideoStudioImageRequest({ ...draft, sourceAssetIds: ['asset-1', 'asset-2'] }, 'd4').sourceAssetIds).toEqual(['asset-1', 'asset-2'])
    // A model the page cannot read is sent as typed and left to the main process to refuse.
    expect(buildVideoStudioImageRequest({ ...draft, model: 'not-a-picture-model' }, 'd5')).toMatchObject({ model: 'not-a-picture-model', size: '720x1280' })
  })

  it('opens the picture dialog on the shared model, then the film model, then the default one', () => {
    const catalog = [{ model: 'gpt-image-2', groups: ['图片模型', 'default'] }, { model: 'gemini-3.1-flash-image', groups: ['图片模型'] }, { model: 'grok-imagine-image', groups: ['default'] }]
    const context = { groups: [{ name: 'default', recommended: true }, { name: '图片模型', recommended: false, image: true }] }
    const film = { imageModel: 'grok-imagine-image', imageGroup: 'default' }
    expect(videoStudioImageModelChoice({ model: 'gemini-3.1-flash-image', group: '图片模型' }, film, catalog, context)).toEqual({ model: 'gemini-3.1-flash-image', group: '图片模型' })
    // The shared group no longer carries the model: another group that does is picked.
    expect(videoStudioImageModelChoice({ model: 'gpt-image-2', group: '没了的分组' }, film, catalog, context)).toEqual({ model: 'gpt-image-2', group: '图片模型' })
    // The shared model was taken down: what this film used before.
    expect(videoStudioImageModelChoice({ model: 'gone-image-model', group: '图片模型' }, film, catalog, context)).toEqual({ model: 'grok-imagine-image', group: 'default' })
    expect(videoStudioImageModelChoice(null, film, catalog, context)).toEqual({ model: 'grok-imagine-image', group: 'default' })
    // Nothing remembered anywhere: the default picture model.
    expect(videoStudioImageModelChoice(null, { imageModel: '', imageGroup: '' }, catalog, context)).toEqual({ model: 'gpt-image-2', group: '图片模型' })
    expect(videoStudioImageModelChoice(null, { imageModel: 'gone-image-model', imageGroup: 'x' }, [], context)).toEqual({ model: '', group: '' })
  })

  it('sizes a shot picture to the frame the film uses unless the customer picked a size', () => {
    const size = (model: string, aspect: '16:9' | '9:16' | '1:1', shared: Parameters<typeof videoStudioImageOptions>[2] = null) => videoStudioImageOptions(model, aspect, shared, {}).size
    expect(size('gpt-image-2', '9:16')).toBe('720x1280')
    expect(size('gpt-image-2', '16:9')).toBe('1280x720')
    // Nothing remembered and a square film: the chat default already fits.
    expect(size('gpt-image-2', '1:1')).toBe('1024x1024')
    // Jimeng stops at 1024 on the long side; both sides stay multiples of 16.
    expect(size('jimeng_high_aes_general_v21_L', '9:16')).toBe('576x1024')
    // Fixed-size models get the size whose shape is closest to the frame.
    expect(size('gemini-3.1-flash-image', '9:16')).toBe('720x1280')
    expect(size('gpt-image-1', '9:16')).toBe('1024x1536')
    expect(size('gpt-image-1', '16:9')).toBe('1536x1024')
    expect(size('grok-imagine-image', '16:9')).toBe('auto')
    // The remembered size already has the frame's shape: it is kept.
    expect(size('gpt-image-2', '16:9', { size: '1536x1024', quality: 'high', imageResolution: '2K' })).toBe('1536x1024')
    // It has the wrong shape: the frame wins, quality and resolution still follow what was remembered.
    expect(videoStudioImageOptions('gpt-image-2', '9:16', { size: '1536x1024', quality: 'high', imageResolution: '2K' }, {})).toEqual({ size: '720x1280', quality: 'high', imageResolution: '2K' })
    // What the model does not take falls back to its own default.
    expect(videoStudioImageOptions('gemini-3.1-flash-image', '1:1', { size: '1040x1040', quality: 'high', imageResolution: '4K' }, {})).toEqual({ size: '1024x1024', quality: 'auto', imageResolution: '4K' })
    expect(videoStudioImageOptions('gpt-image-1', '1:1', { size: '1024x1024', quality: 'medium', imageResolution: '4K' }, {})).toEqual({ size: '1024x1024', quality: 'medium', imageResolution: '1K' })
    // What the customer changed in the dialog wins, even a size against the frame or one still being typed.
    expect(videoStudioImageOptions('gpt-image-2', '9:16', { size: '1536x1024', quality: 'high', imageResolution: '2K' }, { size: '1024x1024', quality: 'low' })).toEqual({ size: '1024x1024', quality: 'low', imageResolution: '2K' })
    expect(videoStudioImageOptions('gpt-image-2', '9:16', null, { size: '10x' }).size).toBe('10x')
    // A model the page cannot read keeps what was remembered.
    expect(videoStudioImageOptions('not-a-picture-model', '9:16', null, {})).toEqual({ size: '1024x1024', quality: 'low', imageResolution: '1K' })
    expect(videoStudioImageSize({ kind: 'allow-list', values: ['odd'], default: '512x512' }, '16:9')).toBe('512x512')
    expect(videoStudioImageSize({ kind: 'divisible', divisor: 64, min: 768, max: 4096, default: '1024x1024' }, '9:16')).toBe('768x1280')
  })

  it('remembers the dialog choice without letting a film frame change the shared size', () => {
    const draft = { prompt: '橘猫', model: 'gpt-image-2', group: '图片模型', size: '720x1280', quality: 'high' as const, imageResolution: '2K' as const }
    const shared = { size: '1536x1024', quality: 'low' as const, imageResolution: '1K' as const }
    // The size was picked for the film: the shared one stays.
    expect(videoStudioImageSettingsToShare(draft, shared, false)).toEqual({ model: 'gpt-image-2', group: '图片模型', size: '1536x1024', quality: 'high', imageResolution: '2K' })
    // The customer picked it: it is remembered.
    expect(videoStudioImageSettingsToShare(draft, shared, true)).toEqual({ model: 'gpt-image-2', group: '图片模型', size: '720x1280', quality: 'high', imageResolution: '2K' })
    // Nothing remembered yet: the chat default.
    expect(videoStudioImageSettingsToShare(draft, null, false).size).toBe('1024x1024')
    // The remembered size is one the newly picked model does not take: that model's default.
    expect(videoStudioImageSettingsToShare({ ...draft, model: 'grok-imagine-image', size: 'auto' }, shared, false).size).toBe('auto')
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

    const failed = finishVideoStudioShotDrawing(startVideoStudioShotDrawing(drawn, 'shot-1', 'd5'), 'shot-1', 'd5', { error: '未收到生成的图片' })
    expect(failed.shots[0]).toMatchObject({ image: drawn.shots[0].image, drawError: '未收到生成的图片' })
    expect(failed.shots[0]).not.toHaveProperty('drawing')
    const stopped = finishVideoStudioShotDrawing(startVideoStudioShotDrawing(failed, 'shot-1', 'd6'), 'shot-1', 'd6', 'stopped')
    expect(stopped.shots[0].image).toEqual(drawn.shots[0].image)
    expect(stopped.shots[0]).not.toHaveProperty('drawing')
    expect(stopped.shots[0]).not.toHaveProperty('drawError')

    // Drawing state lives only while the page is open.
    const stored = serializeVideoStudioProject(startVideoStudioShotDrawing(failed, 'shot-1', 'd7'))
    expect(JSON.stringify(stored)).not.toMatch(/d7|drawError|未收到生成的图片/)
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

  it('lets go of the film once a setting that ends up in it changes, and keeps it for settings that do not', () => {
    const project = planned()
    const film: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('abc'[index]), status: 'done' })), exported: clip('f') }
    for (const patch of [{ captionSize: 'large' }, { captionPosition: 'top' }, { transition: 'fade' }, { fadeOut: true }, { aspect: '16:9' }, { fit: 'contain' }, { resolution: 1080 }, { captions: false }] as const) {
      const changed = changeVideoStudioSettings(film, patch)
      expect(changed.settings).toMatchObject(patch)
      expect(changed.exported, JSON.stringify(patch)).toBeUndefined()
    }
    // Models, the idea, how many shots and how long each are only for what gets made next; the film made from the clips in hand still matches.
    for (const patch of [{ videoModel: 'minimax-h3-base', videoGroup: 'vip' }, { textModel: 'gpt-5.6-sol' }, { imageModel: 'gpt-image-2', imageGroup: 'default' }, { idea: '换个想法' }, { shotCount: 4 }, { secondsPerShot: 8 }]) {
      expect(changeVideoStudioSettings(film, patch).exported, JSON.stringify(patch)).toEqual(clip('f'))
    }
    // Picking the value already chosen keeps the film too.
    expect(changeVideoStudioSettings(film, { captionSize: film.settings.captionSize, transition: film.settings.transition }).exported).toEqual(clip('f'))
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
    // It may have nothing on that attempt (it could not write it down either), so the shot carries the page's own note:
    // nothing found then still reads as unclear, not as never sent (总单 #42).
    const retrying = restoreVideoStudioProject(JSON.parse(JSON.stringify(serializeVideoStudioProject({
      ...unclear, shots: [{ ...unclear.shots[0], status: 'generating', error: undefined }],
    }))))
    expect(retrying?.shots).toEqual([{ id: 'shot-1', prompt: '雨夜街头的橘猫', caption: '下雨了', requestId: 'lost', unrecorded: true, status: 'generating' }])

    // The mark means nothing without the request it belongs to.
    const orphan = restoreVideoStudioProject({ version: 1, settings: defaultVideoStudioSettings(), title: '', shots: [{ id: 'x', prompt: '一', caption: '', unconfirmed: true }] })
    expect(orphan?.shots).toEqual([{ id: 'x', prompt: '一', caption: '', status: 'idle' }])
  })

  // 总单 #42（11-18 复核 N2）：交出去前主进程没记下的那一单，页面替它记着；重开以后照样先去接，接不回来再按结果不明提醒。
  it('keeps the page note of a submission the main process could not write down across a reopen', () => {
    const project = planned()
    const running: VideoStudioProject = {
      ...project,
      shots: [
        { ...project.shots[0], status: 'generating', requestId: 'unrecorded', unrecorded: true, stage: 'processing', progress: 10 },
        { ...project.shots[1], status: 'generating', requestId: 'recorded', stage: 'processing' },
      ],
    }
    const restored = restoreVideoStudioProject(JSON.parse(JSON.stringify(serializeVideoStudioProject(running))))
    expect(restored?.shots).toEqual([
      { id: 'shot-1', prompt: '雨夜街头的橘猫', caption: '下雨了', requestId: 'unrecorded', unrecorded: true, status: 'generating' },
      { id: 'shot-2', prompt: '橘猫穿过人群', caption: '', requestId: 'recorded', status: 'generating' },
    ])
    expect(videoStudioUnconfirmedIndexes(restored!, ['shot-1', 'shot-2'])).toEqual([])

    // A shot already settled as unclear keeps that, and the note means nothing without the request it belongs to.
    const stored = restoreVideoStudioProject({
      version: 1, settings: defaultVideoStudioSettings(), title: '',
      shots: [
        { id: 'a', prompt: '一', caption: '', requestId: 'lost', unconfirmed: true, unrecorded: true },
        { id: 'b', prompt: '二', caption: '', unrecorded: true },
        { id: 'c', prompt: '三', caption: '', requestId: 'odd', unrecorded: 'yes' },
      ],
    })
    expect(stored?.shots).toEqual([
      { id: 'a', prompt: '一', caption: '', requestId: 'lost', unconfirmed: true, error: aiVideoUnconfirmedSubmissionMessage, status: 'failed' },
      { id: 'b', prompt: '二', caption: '', status: 'idle' },
      { id: 'c', prompt: '三', caption: '', requestId: 'odd', status: 'generating' },
    ])
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

  it('names a film by its title or the start of its idea and tells how far it got', () => {
    const film = planned()
    expect(videoStudioDraftName(film)).toBe('回家的猫')
    expect(videoStudioDraftName({ ...film, title: '', settings: { ...film.settings, idea: '一只橘猫\n在下雨的东京街头找回家的路，温暖治愈，最后它在家门口被主人抱起来' } })).toBe('一只橘猫 在下雨的东京街头找回家的路，温暖治愈，…')
    expect(videoStudioDraftName({ ...film, title: '', settings: { ...film.settings, idea: '' } })).toBe('未命名视频')
    expect(videoStudioDraftProgress(createVideoStudioProject())).toBe('尚未编写分镜')
    const made = { ...film, shots: film.shots.map((shot, index) => index ? shot : { ...shot, clip: clip('a'), status: 'done' as const }) }
    expect(videoStudioDraftProgress(made)).toBe('3 个镜头 · 已生成 1 段')
    expect(videoStudioDraftProgress({ ...made, exported: clip('z') })).toBe('3 个镜头 · 已生成 1 段 · 已合成成片')
  })

  // 0.2.24 及以前草稿箱在 localStorage 里的写法（当时的 serializeVideoStudioDrafts）。新版不再写它，只在头一次打开时读一遍。
  function legacyDraftBox(drafts: readonly VideoStudioDraft[]): unknown {
    return { version: 1, drafts: drafts.map((draft) => ({ id: draft.id, savedAt: draft.savedAt, project: serializeVideoStudioProject(draft.project) })) }
  }

  it('still reads the draft box older versions kept next to the film in hand, and only drafts it can trust', () => {
    expect(videoStudioDraftsStorageKey('xm:7')).toBe(`${videoStudioStorageKey('xm:7')}:drafts`)
    const film = { ...planned(), shots: planned().shots.map((shot, index) => index ? shot : { ...shot, clip: clip('a'), status: 'done' as const }) }
    const drafts: VideoStudioDraft[] = [{ id: 'draft-1', savedAt: 1_700_000_000_000, project: film }]
    const stored = JSON.parse(JSON.stringify(legacyDraftBox(drafts)))
    expect(restoreVideoStudioDrafts(stored, ids())).toEqual([{ id: 'draft-1', savedAt: 1_700_000_000_000, project: restoreVideoStudioProject(serializeVideoStudioProject(film), ids()) }])
    const project = serializeVideoStudioProject(film)
    expect(restoreVideoStudioDrafts({ version: 2, drafts: [{ id: 'a', savedAt: 1, project }] })).toEqual([])
    expect(restoreVideoStudioDrafts({ version: 1, drafts: 'nope' })).toEqual([])
    // 坏的那一份丢掉，别的照留；重名的换一个编号；空工程不留；超过上限的不读。
    const restored = restoreVideoStudioDrafts({ version: 1, drafts: [
      { id: 'a', savedAt: 1, project },
      { id: 'a', savedAt: 2, project },
      { id: '../x', savedAt: 3, project },
      { id: 'b', savedAt: -1, project },
      { id: 'c', savedAt: 4, project: { version: 9 } },
      { id: 'd', savedAt: 5, project: serializeVideoStudioProject(createVideoStudioProject()) },
      null,
    ] }, ids())
    expect(restored.map((draft) => [draft.id, draft.savedAt])).toEqual([['a', 1], ['shot-1', 2], ['shot-2', 3]])
    const many = Array.from({ length: maxVideoStudioDrafts + 5 }, (_, index) => ({ id: `d${index}`, savedAt: index, project }))
    expect(restoreVideoStudioDrafts({ version: 1, drafts: many })).toHaveLength(maxVideoStudioDrafts)
  })

  // 草稿里没等到结果的那段，读回来是「生成中」：打开这一条时工作台拿请求号去接（useVideoStudio 的 resumeOpenClips）。
  it('reads a draft clip still out as generating, like the film in hand after the page reopens', () => {
    const film = planned()
    const waiting = { ...film, shots: film.shots.map((shot, index) => index === 1 ? { ...shot, requestId: 'req-1', status: 'failed' as const, error: '暂时查不到视频进度' } : shot) }
    const [draft] = restoreVideoStudioDrafts(legacyDraftBox([{ id: 'a', savedAt: 1, project: waiting }]))
    expect(draft.project.shots[1]).toMatchObject({ requestId: 'req-1', status: 'generating' })
  })
})

describe('a clip handed over from a conversation', () => {
  const assetId = 'c'.repeat(43)
  const handed: AiVideoClip = { assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'video'), width: 1280, height: 720, durationSeconds: 5 }
  const imageAssetId = 'i'.repeat(43)
  const ids = () => { let next = 0; return () => `shot-${++next}` }

  it('goes in as a finished last shot with its prompt and start image, and nothing is generated again', () => {
    const project = { ...addVideoStudioShot(createVideoStudioProject(), () => 'first'), title: '橘猫回家' }
    const next = appendVideoStudioClip(project, { prompt: '  一只橘猫\u000c在雨里走  ', clip: handed, imageAssetId }, ids())
    expect(next.shots).toHaveLength(2)
    expect(next.shots[0]).toBe(project.shots[0])
    // 记成用的是现成的片段：不是照这条视频的设置出的。
    expect(next.shots[1]).toMatchObject({ id: 'shot-1', prompt: '一只橘猫在雨里走', caption: '', clip: handed, borrowed: true, status: 'done', image: { assetId: imageAssetId } })
    expect(next.shots[1]).not.toHaveProperty('requestId')
    expect(next.title).toBe('橘猫回家')
    expect(appendVideoStudioClip(project, { prompt: '没有开头图', clip: handed }, ids()).shots[1]).not.toHaveProperty('image')
  })

  it('cuts an overlong prompt to what a shot holds', () => {
    const next = appendVideoStudioClip(createVideoStudioProject(), { prompt: 'x'.repeat(videoStudioPlanLimits.maximumPromptLength + 20), clip: handed }, ids())
    expect(next.shots[0].prompt).toHaveLength(videoStudioPlanLimits.maximumPromptLength)
  })

  it('drops the finished film, because it no longer has every shot in it', () => {
    const exported = { ...createVideoStudioProject(), exported: { assetId: 'e'.repeat(43), durationSeconds: 12 } }
    expect(appendVideoStudioClip(exported as ReturnType<typeof createVideoStudioProject>, { prompt: '多一段', clip: handed }, ids())).not.toHaveProperty('exported')
  })

  it('leaves a full film untouched', () => {
    let full = createVideoStudioProject()
    for (let index = 0; index < videoStudioPlanLimits.maximumShots; index += 1) full = addVideoStudioShot(full, () => `s${index}`)
    expect(canAddVideoStudioShot(full)).toBe(false)
    expect(appendVideoStudioClip(full, { prompt: '放不下', clip: handed }, ids())).toBe(full)
  })

  it('starts a new film around the clip: its prompt as the idea, its shape and model, the rest from the base settings', () => {
    const base = { ...defaultVideoStudioSettings(), textModel: 'gpt-5.6-sol', textGroup: 'GPT', imageModel: 'gpt-image-2', imageGroup: '图片模型', captions: false, idea: '上一条的想法', aspect: '9:16' as const }
    const film = createVideoStudioProjectFromClip({ prompt: '一只橘猫在雨里走', clip: handed, imageAssetId }, { aspect: '16:9', model: 'minimax-h3-base', group: '图片模型', seconds: 3 }, base, ids())
    expect(film.settings).toMatchObject({ idea: '一只橘猫在雨里走', aspect: '16:9', videoModel: 'minimax-h3-base', videoGroup: '图片模型', textModel: 'gpt-5.6-sol', imageModel: 'gpt-image-2', captions: false })
    // MiniMax 最短 5 秒：接着加的镜头不会按一个它出不了的时长去要。
    expect(film.settings.secondsPerShot).toBe(clampVideoStudioSeconds(3, 'minimax-h3-base'))
    expect(film.shots).toHaveLength(1)
    expect(film.shots[0]).toMatchObject({ clip: handed, borrowed: true, status: 'done', prompt: '一只橘猫在雨里走' })
    expect(isVideoStudioProjectEmpty(film)).toBe(false)
  })

  it('keeps the base length when the clip came without a video model', () => {
    const film = createVideoStudioProjectFromClip({ prompt: '一只橘猫', clip: handed }, { aspect: '1:1', model: '', group: '', seconds: 9 }, undefined, ids())
    expect(film.settings).toMatchObject({ aspect: '1:1', videoModel: '', videoGroup: '', secondsPerShot: defaultVideoStudioSettings().secondsPerShot })
  })

  it('builds the same request for one chat message as for one storyboard shot', () => {
    const settings = { ...defaultVideoStudioSettings(), videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', aspect: '16:9' as const, secondsPerShot: 6 }
    const shot = { id: 'a', prompt: '橘猫', caption: '', status: 'idle' as const }
    expect(buildVideoClipRequest({ requestId: 'r1', group: '图片模型', model: 'grok-imagine-video-1.5', prompt: '橘猫', seconds: 6, aspect: '16:9' })).toEqual(buildVideoStudioClipRequest(settings, shot, 'r1'))
    expect(buildVideoClipRequest({ requestId: 'r2', group: '图片模型', model: 'minimax-h3-base', prompt: '橘猫', seconds: 6, aspect: '9:16', imageAssetId })).toMatchObject({ mode: 'i2va', aspectRatio: '9:16', imageAssetIds: [imageAssetId] })
  })

  it('words the pay-twice warning for one clip, for all of them and for some of them', () => {
    expect(videoStudioUnconfirmedWarning([0], 1)).toMatch(/^这一段上次提交时未收到/)
    expect(videoStudioUnconfirmedWarning([0, 1], 2)).toMatch(/^这几段上次提交时未收到/)
    expect(videoStudioUnconfirmedWarning([1, 3], 4)).toMatch(/^其中第 2、4 段上次提交时未收到/)
    expect(videoStudioUnconfirmedWarning([0], 1)).toContain('重新生成将再次计费，可能产生重复扣费。')
  })
})

describe('a ready-made clip from the library on a shot', () => {
  const assetId = 'l'.repeat(43)
  const ready: AiVideoClip = { assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'video'), width: 1280, height: 720, durationSeconds: 10 }
  const ids = () => { let next = 0; return () => `shot-${++next}` }

  it('goes onto the shot as its clip without generating, keeps a written prompt and fills an empty one', () => {
    const project = planned()
    const first = project.shots[0].id
    const next = assignVideoStudioShotClip(project, first, { prompt: '作品库里那一段的描述', clip: ready })
    expect(next.shots[0]).toMatchObject({ prompt: '雨夜街头的橘猫', caption: '下雨了', clip: ready, borrowed: true, status: 'done' })
    expect(next.shots[1]).toBe(project.shots[1])
    const empty = addVideoStudioShot(createVideoStudioProject(), () => 'blank')
    expect(assignVideoStudioShotClip(empty, 'blank', { prompt: '  作品库里\u000c那一段的描述  ', clip: ready }).shots[0]).toMatchObject({ prompt: '作品库里那一段的描述', borrowed: true })
    expect(assignVideoStudioShotClip(empty, 'missing', { prompt: '', clip: ready })).toBe(empty)
  })

  it('replaces a generated clip, clears its trim and drops the finished film', () => {
    const project = planned()
    const first = project.shots[0].id
    const made = { ...project, exported: clip('e'), shots: project.shots.map((shot) => shot.id === first ? { ...shot, clip: clip('g'), status: 'done' as const, trimStart: 1, trimEnd: 0.5 } : shot) }
    const next = assignVideoStudioShotClip(made, first, { prompt: '', clip: ready })
    expect(next.shots[0]).toMatchObject({ clip: ready, borrowed: true })
    expect(next.shots[0]).not.toHaveProperty('trimStart')
    expect(next.shots[0]).not.toHaveProperty('trimEnd')
    expect(next).not.toHaveProperty('exported')
  })

  it('leaves a shot that is generating or being drawn alone', () => {
    const project = planned()
    const first = project.shots[0].id
    const generating = { ...project, shots: project.shots.map((shot) => shot.id === first ? { ...shot, status: 'generating' as const, requestId: 'r1' } : shot) }
    expect(assignVideoStudioShotClip(generating, first, { prompt: '', clip: ready })).toBe(generating)
    const drawing = startVideoStudioShotDrawing(project, first, 'draw-1')
    expect(isVideoStudioShotDrawing(drawing.shots[0])).toBe(true)
    expect(assignVideoStudioShotClip(drawing, first, { prompt: '', clip: ready })).toBe(drawing)
  })

  it('goes back to not generated when the clip is taken off, and only a ready-made clip can be taken off', () => {
    const project = planned()
    const first = project.shots[0].id
    const borrowed = setVideoStudioShotTrim(assignVideoStudioShotClip(project, first, { prompt: '', clip: ready }), first, 'start', 1)
    expect(borrowed.shots[0]).toMatchObject({ trimStart: 1 })
    const removed = removeVideoStudioShotClip({ ...borrowed, exported: clip('e') }, first)
    expect(removed.shots[0]).toMatchObject({ status: 'idle', prompt: '雨夜街头的橘猫' })
    for (const key of ['clip', 'borrowed', 'trimStart']) expect(removed.shots[0]).not.toHaveProperty(key)
    expect(removed).not.toHaveProperty('exported')
    const generated = { ...project, shots: project.shots.map((shot) => shot.id === first ? { ...shot, clip: clip('g'), status: 'done' as const } : shot) }
    expect(removeVideoStudioShotClip(generated, first)).toBe(generated)
    expect(removeVideoStudioShotClip(project, first)).toBe(project)
  })

  it('keeps the marks of an order whose answer never came, so taking the clip off still warns about paying twice', () => {
    const project = planned()
    const first = project.shots[0].id
    const unconfirmed = { ...project, shots: project.shots.map((shot) => shot.id === first ? { ...shot, status: 'failed' as const, requestId: 'r1', unconfirmed: true, error: aiVideoUnconfirmedSubmissionMessage } : shot) }
    const borrowed = assignVideoStudioShotClip(unconfirmed, first, { prompt: '', clip: ready })
    expect(borrowed.shots[0]).toMatchObject({ status: 'done', borrowed: true, requestId: 'r1', unconfirmed: true })
    const removed = removeVideoStudioShotClip(borrowed, first)
    expect(removed.shots[0]).toMatchObject({ status: 'failed', requestId: 'r1', unconfirmed: true, error: aiVideoUnconfirmedSubmissionMessage })
    expect(videoStudioUnconfirmedIndexes(removed, [first])).toEqual([0])
    // 报错那句没存下来（只剩请求号和标记）时补回主进程那句提醒。
    const bare = { ...borrowed, shots: borrowed.shots.map((shot) => { const { error: _error, ...rest } = shot; return rest }) }
    expect(removeVideoStudioShotClip(bare, first).shots[0]).toMatchObject({ status: 'failed', error: aiVideoUnconfirmedSubmissionMessage })
  })

  it('stops being ready-made once a generated clip replaces it', () => {
    const shot = { id: 'a', prompt: '橘猫', caption: '', status: 'done' as const, clip: ready, borrowed: true }
    expect(withoutVideoStudioBorrowed(shot)).toEqual({ id: 'a', prompt: '橘猫', caption: '', status: 'done', clip: ready })
  })

  it('survives a save and a reopen, and an older file without the mark reads as a generated clip', () => {
    const project = planned()
    const first = project.shots[0].id
    const borrowed = assignVideoStudioShotClip(project, first, { prompt: '', clip: ready })
    const saved = serializeVideoStudioProject(borrowed)
    const reopened = restoreVideoStudioProject(JSON.parse(JSON.stringify(saved)))
    expect(reopened?.shots[0]).toMatchObject({ clip: ready, borrowed: true, status: 'done' })
    expect(reopened?.shots[1]).not.toHaveProperty('borrowed')
    const generated = { ...project, shots: project.shots.map((shot) => shot.id === first ? { ...shot, clip: clip('g'), status: 'done' as const } : shot) }
    expect(restoreVideoStudioProject(JSON.parse(JSON.stringify(serializeVideoStudioProject(generated))))?.shots[0]).not.toHaveProperty('borrowed')
    // 记号只跟着片段走：没有片段的镜头上写了它也不认。
    const stray = JSON.parse(JSON.stringify(serializeVideoStudioProject(project))) as { shots: Array<Record<string, unknown>> }
    stray.shots[0].borrowed = true
    expect(restoreVideoStudioProject(stray)?.shots[0]).not.toHaveProperty('borrowed')
  })

  it('counts a ready-made clip by its own length, not by the length the shot would be generated at', () => {
    const project = planned()
    const [first, second, third] = project.shots.map((shot) => shot.id)
    const planLength = videoStudioShotSeconds(project.shots[0], project.settings)
    expect(videoStudioTotalSeconds(project)).toBe(planLength * 3)
    const one = assignVideoStudioShotClip(project, first, { prompt: '', clip: ready })
    expect(videoStudioTotalSeconds(one)).toBe(10 + planLength * 2)
    expect(videoStudioCommonSeconds(one)).toBeNull()
    expect(videoStudioTotalSeconds(setVideoStudioShotTrim(one, first, 'end', 2))).toBe(8 + planLength * 2)
    // 不知道多长的那一段还是照定的时长算。
    const { durationSeconds: _duration, ...unknown } = ready
    expect(videoStudioTotalSeconds(assignVideoStudioShotClip(project, first, { prompt: '', clip: unknown }))).toBe(planLength * 3)
    // 三段都是现成的、差不多一样长（量出来带小数）：照整秒说「每段 S 秒」。
    const close = [first, second, third].reduce((current, id, index) => assignVideoStudioShotClip(current, id, { prompt: '', clip: { ...ready, durationSeconds: 5 + index * 0.04 } }), project)
    expect(videoStudioCommonSeconds(close)).toBe(5)
    expect(videoStudioTotalSeconds(close)).toBe(15)
  })

  it('starts a new film from several clips, one shot each in the order picked', () => {
    const second: AiVideoClip = { ...ready, assetId: 'm'.repeat(43), durationSeconds: 5 }
    const base = { ...defaultVideoStudioSettings(), textModel: 'gpt-5.6-sol', textGroup: 'GPT', captions: false, idea: '上一条的想法', aspect: '9:16' as const, videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', secondsPerShot: 6 }
    const film = createVideoStudioProjectFromClips([{ prompt: '', clip: ready }, { prompt: '橘猫跳上台阶', clip: second, imageAssetId: 'i'.repeat(43) }], { aspect: '16:9', model: '', group: '', seconds: 10 }, base, ids())
    expect(film.shots).toHaveLength(2)
    expect(film.shots[0]).toMatchObject({ id: 'shot-1', prompt: '', clip: ready, borrowed: true, status: 'done' })
    expect(film.shots[1]).toMatchObject({ id: 'shot-2', prompt: '橘猫跳上台阶', clip: second, borrowed: true, status: 'done', image: { assetId: 'i'.repeat(43) } })
    // 想法填第一句写得出来的描述；画面比例照第一段；没带模型时出片的模型和时长照原来的。
    expect(film.settings).toMatchObject({ idea: '橘猫跳上台阶', aspect: '16:9', videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', secondsPerShot: 6, textModel: 'gpt-5.6-sol', captions: false })
    expect(isVideoStudioProjectEmpty(film)).toBe(false)
    expect(videoStudioReadyToCompose(film)).toBe(true)
    const made = createVideoStudioProjectFromClips([{ prompt: '一只橘猫', clip: ready }], { aspect: '1:1', model: 'minimax-h3-base', group: '视频模型', seconds: 3 }, base, ids())
    expect(made.settings).toMatchObject({ idea: '一只橘猫', aspect: '1:1', videoModel: 'minimax-h3-base', videoGroup: '视频模型', secondsPerShot: clampVideoStudioSeconds(3, 'minimax-h3-base') })
    const many = createVideoStudioProjectFromClips(Array.from({ length: videoStudioPlanLimits.maximumShots + 3 }, () => ({ prompt: '', clip: ready })), { aspect: '16:9', model: '', group: '', seconds: 5 }, undefined, ids())
    expect(many.shots).toHaveLength(videoStudioPlanLimits.maximumShots)
    expect(many.settings.idea).toBe('')
  })
})
