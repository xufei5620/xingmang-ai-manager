import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import { applyVideoStudioPlan, createVideoStudioProject, defaultVideoStudioSettings, serializeVideoStudioProject, videoStudioShotImage, videoStudioStorageKey, type VideoStudioProject } from './project'
import type { VideoStudioBridge, VideoStudioStorage } from './useVideoStudio'
import { VideoStudioPage, type VideoStudioAccess } from './VideoStudioPage'

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
  openDiagnosticFolder: unused,
  pickAiChatImages: unused,
  pickVideoStudioMusic: unused,
  readVideoStudioMusic: unused,
  generateAiImage: unused,
  cancelAiChat: unused,
}

function clip(letter: string): AiVideoClip {
  return { assetId: letter.repeat(43), thumbnailUrl: `xingmang-asset://thumb/v2/video/${letter.repeat(43)}`, width: 720, height: 1280, durationSeconds: 12 }
}

function storageWith(scope: string, project: VideoStudioProject | null): VideoStudioStorage {
  const raw = project ? JSON.stringify(serializeVideoStudioProject(project)) : null
  return { getItem: (key) => key === videoStudioStorageKey(scope) ? raw : null, setItem: () => undefined }
}

function render(access: VideoStudioAccess, project: VideoStudioProject | null = null) {
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

  it('says the page is switched off for now and that the projects are still there', () => {
    const markup = render('suspended')
    expect(markup).toContain('data-testid="video-suspended"')
    expect(markup).toContain('视频剪辑暂时停用')
    expect(markup).toContain('你的工程都还在，修好以后会自动恢复。')
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

  it('offers a picture to start each shot from, and shows the one picked in place of the empty thumbnail', () => {
    const project = plannedProject()
    const image = videoStudioShotImage('p'.repeat(43))!
    const withImages: VideoStudioProject = { ...project, shots: [{ ...project.shots[0], image }, { ...project.shots[1], image }, { ...project.shots[1], id: 'shot-3', image: undefined }] }
    const markup = render('ready', withImages)
    // 第一镜已经有片段：左边还是片段，选的图是按钮旁边那张小的。
    expect(markup).toContain('data-testid="video-shot-image-preview-0"')
    expect(markup).not.toContain('data-testid="video-shot-image-thumb-0"')
    // 第二镜还没生成：选的图就在左边那格。
    expect(markup).toMatch(/data-testid="video-shot-image-thumb-1"[^]*?src="xingmang-asset:\/\/image\/p{43}"/)
    expect(markup).not.toContain('data-testid="video-shot-image-preview-1"')
    expect(markup).toMatch(/data-testid="video-shot-image-change-1"[^>]*>[^]*?换一张/)
    expect(markup).toMatch(/data-testid="video-shot-image-remove-1"[^>]*>[^]*?不用这张图/)
    expect(markup).toMatch(/title="生成时从这张图动起来，适合商品图、人物照片"[^>]*data-testid="video-shot-image-2"[^>]*>[^]*?用一张图开头/)
    expect(markup).not.toContain('data-testid="video-shot-image-0"')
  })

  it('offers to have AI draw each shot picture once there is a picture model, and to draw again over one already there', () => {
    const project = plannedProject()
    const image = videoStudioShotImage('p'.repeat(43))!
    const withImage: VideoStudioProject = { ...project, shots: [project.shots[0], { ...project.shots[1], image }] }
    const noModel = render('ready', withImage)
    expect(noModel).toMatch(/<span>画镜头图<\/span>[^]*?data-testid="video-image-model"/)
    // 还没读到画图模型：按钮在，但是灰的。
    expect(noModel).toMatch(/<button title="按这一镜的画面描述先画一张图，满意了再拿它生成视频；画图单独计费"[^>]*data-testid="video-shot-draw-0" disabled=""[^>]*>[^]*?让 AI 画一张/)
    const ready = render('ready', { ...withImage, settings: { ...withImage.settings, imageModel: 'gpt-image-2', imageGroup: '图片模型' } })
    expect(ready).toMatch(/data-model="gpt-image-2" data-group="图片模型"[^>]*data-testid="video-image-model"/)
    expect(ready).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="video-shot-draw-0"[^>]*>[^]*?让 AI 画一张/)
    expect(ready).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="video-shot-draw-1"[^>]*>[^]*?再画一张/)
    expect(ready).not.toContain('正在画图')
    expect(ready).not.toContain('data-testid="video-shot-draw-stop-1"')
  })

  it('offers to trim the start and end of a shot only once it has a clip, and counts the trimmed seconds off the total', () => {
    const project = plannedProject()
    const plain = render('ready', project)
    expect(plain).toMatch(/<label[^>]*>开头剪掉<\/label><select[^>]*data-testid="video-shot-trim-start-0"/)
    expect(plain).toMatch(/<label[^>]*>结尾剪掉<\/label><select[^>]*data-testid="video-shot-trim-end-0"/)
    expect(plain).toMatch(/data-testid="video-shot-trim-start-0"[^>]*><option value="0" selected="">不剪<\/option><option value="0.5">0.5 秒<\/option><option value="1">1 秒<\/option>/)
    expect(plain).not.toContain('data-testid="video-shot-trim-start-1"')
    const trimmed = render('ready', { ...project, shots: [{ ...project.shots[0], trimStart: 1, trimEnd: 0.5 }, project.shots[1]] })
    expect(trimmed).toMatch(/data-testid="video-shot-trim-start-0"[^]*?<option value="1" selected="">1 秒<\/option>/)
    expect(trimmed).toMatch(/data-testid="video-shot-trim-end-0"[^]*?<option value="0.5" selected="">0.5 秒<\/option>/)
    expect(trimmed).toContain('2 个镜头 · 每段 6 秒 · 共约 11 秒')
  })

  it('lets each shot pick its own length and stops saying every shot is as long once they differ', () => {
    const project = plannedProject()
    const plain = render('ready', project)
    expect(plain).toMatch(/<label[^>]*>时长<\/label><select[^>]*data-testid="video-shot-seconds-1"[^>]*>[^]*?<option value="6" selected="">6 秒<\/option>/)
    expect(plain).toContain('2 个镜头 · 每段 6 秒 · 共约 12 秒')
    const mixed = render('ready', { ...project, shots: [project.shots[0], { ...project.shots[1], seconds: 10 }] })
    expect(mixed).toMatch(/data-testid="video-shot-seconds-1"[^>]*>[^]*?<option value="10" selected="">10 秒<\/option>/)
    expect(mixed).toContain('2 个镜头 · 共约 16 秒')
    expect(mixed).not.toContain('每段 6 秒 ·')
  })

  it('offers the caption size and place only while captions are on', () => {
    const project = plannedProject()
    const plain = render('ready', project)
    expect(plain).toMatch(/<label[^>]*>字幕大小<\/label><select[^>]*data-testid="video-caption-size"[^>]*><option value="small">小<\/option><option value="medium" selected="">中<\/option><option value="large">大<\/option>/)
    expect(plain).toMatch(/<label[^>]*>字幕位置<\/label><select[^>]*data-testid="video-caption-position"[^>]*><option value="bottom" selected="">底部<\/option><option value="middle">中间<\/option><option value="top">顶部<\/option>/)
    const off = render('ready', { ...project, settings: { ...project.settings, captions: false } })
    expect(off).not.toContain('data-testid="video-caption-size"')
    expect(off).not.toContain('data-testid="video-caption-position"')
  })

  it('offers a straight cut or a fade between shots and a fade at the end, both off by default', () => {
    const plain = render('ready', plannedProject())
    expect(plain).toMatch(/<label[^>]*>镜头之间<\/label><select[^>]*data-testid="video-transition"[^>]*><option value="cut" selected="">直接切<\/option><option value="fade">淡入淡出<\/option>/)
    expect(plain).toMatch(/data-testid="video-fade-out"[^]*?aria-checked="false"[^]*?>结尾淡出<\/label><small[^>]*>最后一秒画面和声音慢慢淡掉<\/small>/)
    const project = plannedProject()
    const faded = render('ready', { ...project, settings: { ...project.settings, transition: 'fade', fadeOut: true } })
    expect(faded).toMatch(/<option value="fade" selected="">淡入淡出<\/option>/)
    expect(faded).toMatch(/data-testid="video-fade-out"[^]*?aria-checked="true"/)
  })

  it('offers a song under the film, and once one is picked shows its name, change, drop and how loud the clips play', () => {
    const project = plannedProject()
    expect(render('ready', project)).toMatch(/title="从电脑里选一首歌当背景音乐，支持 MP3、M4A、WAV、OGG"[^>]*data-testid="video-music-add"[^>]*>[^]*?加配乐/)
    const markup = render('ready', { ...project, music: { assetId: 'm'.repeat(43), name: '晴天 <live>', clipSound: 'quiet' } })
    expect(markup).not.toContain('data-testid="video-music-add"')
    expect(markup).toMatch(/data-testid="video-music-name"[^>]*>[^]*?晴天 &lt;live&gt;/)
    expect(markup).toMatch(/data-testid="video-music-change"[^>]*>[^]*?换一首/)
    expect(markup).toMatch(/data-testid="video-music-remove"[^>]*>[^]*?不用配乐/)
    expect(markup).toMatch(/<label[^>]*>片段原声<\/label><select[^>]*data-testid="video-clip-sound"/)
    expect(markup).toMatch(/<option value="normal">照常<\/option><option value="quiet" selected="">调小<\/option><option value="off">关掉<\/option>/)
  })

  it('shows the joined film with open, save and open folder once every clip is there', () => {
    const project = plannedProject()
    const done: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('ab'[index]), status: 'done' })), exported: clip('z') }
    const markup = render('ready', done)
    expect(markup).not.toContain('data-testid="video-generate-all"')
    expect(markup).toContain('在这台电脑上拼，不花钱。')
    expect(markup).toContain('data-testid="video-result"')
    expect(markup).toContain('data-testid="video-result-open"')
    expect(markup).toContain('data-testid="video-result-save"')
    expect(markup).toMatch(/data-testid="video-result-folder"[^>]*>[^]*?打开文件夹/)
    expect(markup).toContain('12 秒 · 720 × 1280')
  })
})
