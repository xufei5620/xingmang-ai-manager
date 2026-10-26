import { describe, expect, it } from 'vitest'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import {
  addVideoStudioShot,
  applyVideoStudioPlan,
  buildVideoStudioCatalogs,
  buildVideoStudioClipRequest,
  clampVideoStudioSeconds,
  createVideoStudioProject,
  defaultVideoStudioSettings,
  moveVideoStudioShot,
  removeVideoStudioShot,
  restoreVideoStudioProject,
  serializeVideoStudioProject,
  settleVideoStudioModels,
  videoStudioComposeCaptions,
  videoStudioComposeKey,
  videoStudioReadyToCompose,
  videoStudioSecondsChoices,
  videoStudioShotProblem,
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

  it('offers only the clip lengths a video model can make and moves to the nearest one', () => {
    expect(videoStudioSecondsChoices('grok-imagine-video')).toEqual([3, 4, 5, 6, 8, 10, 12, 15])
    expect(videoStudioSecondsChoices('minimax-h3-base')).toEqual([5, 6, 8, 10, 12, 15])
    expect(clampVideoStudioSeconds(3, 'minimax-h3-base')).toBe(5)
    expect(clampVideoStudioSeconds(9, 'grok-imagine-video')).toBe(8)
    expect(clampVideoStudioSeconds(6, 'gpt-5.6-sol')).toBe(6)
  })

  it('lists text and video models from every prepared group and settles the defaults', () => {
    const groups = [{ name: 'GPT', recommended: true, ratio: 1 }, { name: '图片模型', ratio: 1 }, { name: '其他', ratio: 0.5 }]
    const preparations = {
      GPT: { phase: 'ready' as const, models: ['gpt-5.6-sol', 'gpt-5.4'] },
      图片模型: { phase: 'ready' as const, models: ['gpt-image-2', 'minimax-h3-base', 'grok-imagine-video-1.5', 'sora-2'] },
      其他: { phase: 'ready' as const, models: ['grok-imagine-video-1.5', 'deepseek-v4'] },
    }
    const catalogs = buildVideoStudioCatalogs(groups, preparations)
    expect(catalogs.text.map((entry) => entry.model)).toEqual(['gpt-5.6-sol', 'gpt-5.4', 'deepseek-v4'])
    expect(catalogs.video).toEqual([{ model: 'minimax-h3-base', groups: ['图片模型'] }, { model: 'grok-imagine-video-1.5', groups: ['图片模型', '其他'] }])
    const context = { groups, site: 'solov' as const, settled: true }
    expect(settleVideoStudioModels({ ...defaultVideoStudioSettings(), secondsPerShot: 3 }, catalogs, context)).toEqual({
      textModel: 'gpt-5.6-sol', textGroup: 'GPT', videoModel: 'grok-imagine-video-1.5', videoGroup: '图片模型', secondsPerShot: 3,
    })
    // A remembered MiniMax model stays, and the clip length moves up to what it can make.
    expect(settleVideoStudioModels({ ...defaultVideoStudioSettings(), videoModel: 'minimax-h3-base', secondsPerShot: 3 }, catalogs, context)).toMatchObject({ videoModel: 'minimax-h3-base', videoGroup: '图片模型', secondsPerShot: 5 })
    // While groups are still loading a missing remembered model is kept rather than replaced.
    expect(settleVideoStudioModels({ ...defaultVideoStudioSettings(), textModel: 'claude-x', textGroup: 'Claude' }, catalogs, { ...context, settled: false })).toMatchObject({ textModel: 'claude-x', textGroup: 'Claude' })
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
  })

  it('stores the storyboard and clip ids but not what was running', () => {
    const project = planned()
    const running: VideoStudioProject = {
      ...project,
      shots: [{ ...project.shots[0], clip: clip('a'), status: 'done' }, { ...project.shots[1], status: 'generating', requestId: 'r', progress: 40 }, project.shots[2]],
      exported: clip('z'),
    }
    const restored = restoreVideoStudioProject(JSON.parse(JSON.stringify(serializeVideoStudioProject(running))))
    expect(restored?.shots).toEqual([
      { id: 'shot-1', prompt: '雨夜街头的橘猫', caption: '下雨了', clip: clip('a'), status: 'done' },
      { id: 'shot-2', prompt: '橘猫穿过人群', caption: '', status: 'idle' },
      { id: 'shot-3', prompt: '橘猫跳上台阶', caption: '到家了', status: 'idle' },
    ])
    expect(restored?.exported).toEqual(clip('z'))
    expect(restored?.title).toBe('回家的猫')
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
        { id: '../../x', prompt: 3 },
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
})
