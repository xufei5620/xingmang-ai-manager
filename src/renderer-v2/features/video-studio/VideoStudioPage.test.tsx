import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import { applyVideoStudioPlan, createVideoStudioProject, defaultVideoStudioSettings, serializeVideoStudioProject, videoStudioStorageKey, type VideoStudioProject } from './project'
import type { VideoStudioBridge, VideoStudioStorage } from './useVideoStudio'
import { VideoStudioPage } from './VideoStudioPage'

// 只渲染首屏：effect 不跑，所以这里不会读模型、不会发任何请求。
function unused(): never { throw new Error('not expected during a static render') }
const bridge: VideoStudioBridge = {
  listAiChatGroups: unused,
  prepareAiChatGroup: unused,
  planVideoStudio: unused,
  generateAiVideo: unused,
  resumeAiVideo: unused,
  cancelAiVideo: unused,
  onAiVideoProgress: unused,
  readAiVideoClip: unused,
  storeVideoStudioExport: unused,
  openAiVideo: unused,
  saveAiVideo: unused,
}

function clip(letter: string): AiVideoClip {
  return { assetId: letter.repeat(43), thumbnailUrl: `xingmang-asset://thumb/v2/video/${letter.repeat(43)}`, width: 720, height: 1280, durationSeconds: 12 }
}

function storageWith(scope: string, project: VideoStudioProject | null): VideoStudioStorage {
  const raw = project ? JSON.stringify(serializeVideoStudioProject(project)) : null
  return { getItem: (key) => key === videoStudioStorageKey(scope) ? raw : null, setItem: () => undefined }
}

function render(access: 'ready' | 'guest' | 'unsupported', project: VideoStudioProject | null = null) {
  return renderToStaticMarkup(<VideoStudioPage bridge={bridge} accountScope="solov:7" site="solov" access={access} onLogin={() => undefined}
    options={{ storage: storageWith('solov:7', project) }} />)
}

function plannedProject(): VideoStudioProject {
  let next = 0
  const project = applyVideoStudioPlan(createVideoStudioProject({ ...defaultVideoStudioSettings(), idea: '回家的猫' }), {
    title: '回家的猫',
    shots: [{ prompt: '雨夜街头的橘猫', caption: '下雨了' }, { prompt: '橘猫跳上台阶', caption: '到家了' }],
  }, () => `shot-${++next}`)
  return { ...project, shots: [{ ...project.shots[0], clip: clip('a'), status: 'done' }, project.shots[1]] }
}

describe('VideoStudioPage', () => {
  it('asks a guest to sign in before anything that would be billed', () => {
    const markup = render('guest')
    expect(markup).toContain('data-testid="page-video"')
    expect(markup).toContain('data-testid="video-guest"')
    expect(markup).toContain('登录后才能用')
    expect(markup).toContain('data-testid="video-login"')
    expect(markup).not.toContain('data-testid="video-idea-input"')
  })

  it('tells a historical account it cannot use the page, without a sign-in button', () => {
    const markup = render('unsupported')
    expect(markup).toContain('data-testid="video-unsupported"')
    expect(markup).toContain('当前账号用不了视频剪辑')
    expect(markup).not.toContain('data-testid="video-login"')
    expect(markup).not.toContain('data-testid="video-idea-input"')
  })

  it('opens on just the idea card with the plan button off until there is an idea', () => {
    const markup = render('ready')
    expect(markup).toContain('data-testid="video-idea-input"')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="video-plan"|<button[^>]*data-testid="video-plan"[^>]*disabled=""/)
    expect(markup).toContain('写分镜按文字模型的用量计费；之后每生成一段视频单独计费。')
    expect(markup).not.toContain('data-testid="video-shots"')
    expect(markup).not.toContain('data-testid="video-export"')
    expect(markup).not.toContain('data-testid="video-reset"')
  })

  it('brings back a saved storyboard with the clip it already has and offers only the missing one', () => {
    const markup = render('ready', plannedProject())
    expect(markup).toContain('data-testid="video-reset"')
    expect(markup).toContain('回家的猫')
    expect(markup).toContain('2 个镜头 · 每段 6 秒 · 共约 12 秒')
    expect(markup).toContain('data-testid="video-shot-0"')
    expect(markup).toContain('data-testid="video-shot-1"')
    expect(markup).toContain(`src="xingmang-asset://thumb/v2/video/${'a'.repeat(43)}"`)
    expect(markup).toContain('aria-label="用播放器打开第 1 段"')
    expect(markup).toContain('生成剩下的 1 段')
    expect(markup).toContain('还有 1 个镜头没生成片段。')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="video-compose"|<button[^>]*data-testid="video-compose"[^>]*disabled=""/)
    expect(markup).not.toContain('data-testid="video-result"')
  })

  it('shows a shot that was still generating when the app closed as generating again, not as never made', () => {
    const project = plannedProject()
    const reopened: VideoStudioProject = { ...project, shots: [project.shots[0], { ...project.shots[1], status: 'generating', requestId: 'shot-request' }] }
    const markup = render('ready', reopened)
    expect(markup).toMatch(/data-testid="video-shot-1"[^]*生成中/)
    expect(markup).not.toContain('还没生成')
    expect(markup).toContain('data-testid="video-generate-stop"')
    expect(markup).not.toContain('data-testid="video-generate-all"')
    expect(markup).toContain('等片段都生成好再拼。')
  })

  it('shows the joined film with open and save once every clip is there', () => {
    const project = plannedProject()
    const done: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('ab'[index]), status: 'done' })), exported: clip('z') }
    const markup = render('ready', done)
    expect(markup).not.toContain('data-testid="video-generate-all"')
    expect(markup).toContain('在这台电脑上拼，不花钱。')
    expect(markup).toContain('data-testid="video-result"')
    expect(markup).toContain('data-testid="video-result-open"')
    expect(markup).toContain('data-testid="video-result-save"')
    expect(markup).toContain('12 秒 · 720 × 1280')
  })
})
