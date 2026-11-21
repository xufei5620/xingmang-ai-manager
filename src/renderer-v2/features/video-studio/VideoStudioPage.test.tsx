import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import { tutorialTopics } from '../../registry/tutorials'
import { applyVideoStudioPlan, createVideoStudioProject, defaultVideoStudioSettings, videoStudioShotImage, type VideoStudioProject } from './project'
import type { VideoStudioPriceBridge } from './prices'
import type { VideoStudioBridge } from './useVideoStudio'
import type { VideoStudioSource } from './useVideoStudioLibrary'
import { VideoStudioPage, type VideoStudioAccess, type VideoStudioLibraryPicker } from './VideoStudioPage'

// 只渲染首屏：effect 不跑，所以这里不会读模型、不会发任何请求。
function unused(): never { throw new Error('not expected during a static render') }
const bridge: VideoStudioBridge & VideoStudioPriceBridge = {
  getAccountPriceList: unused,
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

// 开着的那一条视频存着的样子；首屏渲染不会写回去。
function sourceOf(project: VideoStudioProject | null, warning = ''): VideoStudioSource {
  return { read: () => project ?? createVideoStudioProject(), write: () => { throw new Error('a static render must not save the project') }, warning }
}

function render(access: VideoStudioAccess, project: VideoStudioProject | null = null, warning = '', library?: VideoStudioLibraryPicker) {
  return renderToStaticMarkup(<VideoStudioPage bridge={bridge} accountScope="solov:7" site="solov" access={access} onLogin={() => undefined} source={sourceOf(project, warning)} library={library} />)
}

// 「创作」页给的作品库：首屏渲染不会真去挑。
const libraryPicker: VideoStudioLibraryPicker = { pickImage: unused, pickClip: unused }

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
    expect(markup).toContain('登录后可用')
    expect(markup).toContain('data-testid="video-login"')
    expect(markup).not.toContain('data-testid="video-idea-input"')
  })

  it('tells a historical account it cannot use the page, without a sign-in button', () => {
    const markup = render('unsupported')
    expect(markup).toContain('data-testid="video-unsupported"')
    expect(markup).toContain('当前账号无法使用视频剪辑')
    expect(markup).not.toContain('data-testid="video-login"')
    expect(markup).not.toContain('data-testid="video-idea-input"')
  })

  it('says the page is switched off for now and that the projects are still there', () => {
    const markup = render('suspended')
    expect(markup).toContain('data-testid="video-suspended"')
    expect(markup).toContain('视频剪辑暂时停用')
    expect(markup).toContain('您的工程均已保留，修复后将自动恢复。')
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
  })

  it('brings back a saved storyboard with the clip it already has and offers only the missing one', () => {
    const markup = render('ready', plannedProject())
    expect(markup).toContain('回家的猫')
    expect(markup).toContain('2 个镜头 · 每段 6 秒 · 共约 12 秒')
    expect(markup).toContain('data-testid="video-shot-0"')
    expect(markup).toContain('data-testid="video-shot-1"')
    expect(markup).toContain(`src="xingmang-asset://thumb/v2/video/${'a'.repeat(43)}"`)
    expect(markup).toContain('aria-label="用播放器打开第 1 段"')
    expect(markup).toContain('生成剩下的 1 段')
    expect(markup).toContain('仍有 1 个镜头未生成片段。')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="video-compose"|<button[^>]*data-testid="video-compose"[^>]*disabled=""/)
    expect(markup).not.toContain('data-testid="video-result"')
  })

  it('shows a shot that was still generating when the app closed as generating again, not as never made', () => {
    const project = plannedProject()
    const reopened: VideoStudioProject = { ...project, shots: [project.shots[0], { ...project.shots[1], status: 'generating', requestId: 'shot-request' }] }
    const markup = render('ready', reopened)
    expect(markup).toMatch(/data-testid="video-shot-1"[^]*生成中/)
    expect(markup).not.toContain('尚未生成')
    expect(markup).toContain('data-testid="video-generate-stop"')
    expect(markup).not.toContain('data-testid="video-generate-all"')
    expect(markup).toContain('请等待所有片段生成完成后再合成。')
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
    expect(markup).toMatch(/data-testid="video-shot-image-remove-1"[^>]*>[^]*?不使用此图/)
    expect(markup).toMatch(/title="生成时从这张图动起来，适合商品图、人物照片"[^>]*data-testid="video-shot-image-2"[^>]*>[^]*?用一张图开头/)
    expect(markup).not.toContain('data-testid="video-shot-image-0"')
  })

  it('offers a picture or a ready-made clip from the library on each shot only when the page was given the library', () => {
    const project = plannedProject()
    const plain = render('ready', project)
    expect(plain).not.toContain('从作品库选图')
    expect(plain).not.toContain('使用已有片段')
    const markup = render('ready', project, '', libraryPicker)
    for (const index of [0, 1]) {
      expect(markup).toMatch(new RegExp(`title="从作品库选择一张图片作为开头图"[^>]*data-testid="video-shot-library-image-${index}"[^>]*>[^]*?从作品库选图`))
      expect(markup).toMatch(new RegExp(`title="使用作品库中已有的视频片段，无需生成"[^>]*data-testid="video-shot-library-clip-${index}"[^>]*>[^]*?使用已有片段`))
    }
    // 已经选了开头图的镜头上也有这两个。
    const image = videoStudioShotImage('p'.repeat(43))!
    const withImage = render('ready', { ...project, shots: [project.shots[0], { ...project.shots[1], image }] }, '', libraryPicker)
    expect(withImage).toContain('data-testid="video-shot-library-image-1"')
    expect(withImage).toContain('data-testid="video-shot-library-clip-1"')
  })

  it('marks a shot that uses a ready-made clip and offers to change or drop the clip in place of generating', () => {
    const project = plannedProject()
    const borrowed: VideoStudioProject = { ...project, shots: [project.shots[0], { ...project.shots[1], clip: clip('b'), borrowed: true, status: 'done' }] }
    const markup = render('ready', borrowed, '', libraryPicker)
    const [first, second] = markup.split('data-testid="video-shot-1"')
    // 第一镜是自己生成的：照旧「已生成」「重新生成」，能定时长。
    expect(first).toContain('已生成')
    expect(first).toContain('data-testid="video-shot-generate-0"')
    expect(first).toContain('data-testid="video-shot-seconds-0"')
    expect(first).toContain('>已生成</span>')
    expect(first).not.toContain('>已有片段</span>')
    // 第二镜用的是现成的片段：牌子、两个按钮；不生成，也就没有「重新生成」和「时长」，剪头剪尾还在。
    expect(second).toContain('>已有片段</span>')
    expect(second).toMatch(/data-testid="video-shot-clip-change-1"[^>]*>[^]*?更换片段/)
    expect(second).toMatch(/data-testid="video-shot-clip-remove-1"[^>]*>[^]*?不使用此片段/)
    expect(second).not.toContain('data-testid="video-shot-generate-1"')
    expect(second).not.toContain('data-testid="video-shot-seconds-1"')
    expect(second).not.toContain('data-testid="video-shot-library-image-1"')
    expect(second).toContain('data-testid="video-shot-trim-start-1"')
    // 两段都有了：没有「生成剩下的」那个按钮，可以直接拼。
    expect(markup).not.toContain('data-testid="video-generate-all"')
    // 没给作品库的地方也能拿掉这一段，只是没处换。
    const alone = render('ready', borrowed)
    expect(alone).toContain('data-testid="video-shot-clip-remove-1"')
    expect(alone).not.toContain('data-testid="video-shot-clip-change-1"')
  })

  it('offers to have AI draw each shot picture, and to draw again over one already there, with the picture model picked in the dialog', () => {
    const project = plannedProject()
    const image = videoStudioShotImage('p'.repeat(43))!
    const withImage: VideoStudioProject = { ...project, shots: [project.shots[0], { ...project.shots[1], image }] }
    const markup = render('ready', withImage)
    // 画镜头图的型号不在「想法」卡里选了：点了按钮在出图框里选（融合第 4 步），所以按钮不用等读到画图模型。
    expect(markup).not.toContain('画镜头图')
    expect(markup).not.toContain('data-testid="video-image-model"')
    expect(markup).toContain('data-testid="video-text-model"')
    expect(markup).toContain('data-testid="video-video-model"')
    expect(markup).toMatch(/<button title="根据此镜头的画面描述先生成一张图片，确认后再用于生成视频；生成图片单独计费"(?![^>]*disabled)[^>]*data-testid="video-shot-draw-0"[^>]*>[^]*?让 AI 画一张/)
    expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="video-shot-draw-1"[^>]*>[^]*?再画一张/)
    expect(markup).not.toContain('正在画图')
    expect(markup).not.toContain('data-testid="video-shot-draw-stop-1"')
    // 出图框点了才出来。
    expect(markup).not.toContain('data-testid="video-draw-dialog"')
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
    expect(markup).toMatch(/data-testid="video-music-remove"[^>]*>[^]*?不使用配乐/)
    expect(markup).toMatch(/<label[^>]*>片段原声<\/label><select[^>]*data-testid="video-clip-sound"/)
    expect(markup).toMatch(/<option value="normal">照常<\/option><option value="quiet" selected="">调小<\/option><option value="off">关掉<\/option>/)
  })

  it('shows the joined film with open, save and open folder once every clip is there', () => {
    const project = plannedProject()
    const done: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('ab'[index]), status: 'done' })), exported: clip('z') }
    const markup = render('ready', done)
    expect(markup).not.toContain('data-testid="video-generate-all"')
    expect(markup).toContain('在本机合成，不产生费用。')
    expect(markup).toContain('data-testid="video-result"')
    expect(markup).toContain('data-testid="video-result-open"')
    expect(markup).toContain('data-testid="video-result-save"')
    expect(markup).toMatch(/data-testid="video-result-folder"[^>]*>[^]*?打开文件夹/)
    expect(markup).toContain('12 秒 · 720 × 1280')
  })

  // 融合第 1 步：这一页成了「创作」右边的工作台。名字、「重命名」「删除此视频」在外面那条顶栏上，草稿都在左边那一列里。
  it('is only the workbench of one film: no page title, no new or start-over button and no draft box of its own', () => {
    const markup = render('ready', plannedProject())
    expect(markup).not.toContain('xm-page-head')
    expect(markup).not.toContain('<h1')
    for (const gone of ['video-new', 'video-reset', 'video-drafts', 'video-draft-0']) expect(markup).not.toContain(`data-testid="${gone}"`)
    expect(markup).not.toContain('草稿箱')
  })

  it('says so on the page when this film could not be saved on this computer', () => {
    expect(render('ready', plannedProject())).not.toContain('data-testid="video-storage-warning"')
    expect(render('ready', plannedProject(), '本机无法保存此分镜，关闭软件后需重新编写。')).toMatch(/data-testid="video-storage-warning"[^]*?本机无法保存此分镜，关闭软件后需重新编写。/)
  })

  // 教程「视频剪辑」一章（清单第 11 项）照这一页的字教：页面改了按钮名、忘了改教程，这里会红。
  it('shows every button and field the video tutorial tells the customer to look for', () => {
    const topic = tutorialTopics.find((entry) => entry.id === 'video')
    const quoted = [...JSON.stringify(topic?.steps).matchAll(/「([^」]+)」/g)].map((match) => match[1])
    expect(quoted.length).toBeGreaterThan(20)
    const project = plannedProject()
    const fresh: VideoStudioProject = { ...project, shots: project.shots.map((shot) => ({ ...shot, clip: undefined, status: 'idle' })) }
    const done: VideoStudioProject = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, clip: clip('ab'[index]), status: 'done' })), music: { assetId: 'm'.repeat(43), name: '晴天', clipSound: 'quiet' }, exported: clip('z') }
    const markup = [render('ready', fresh), render('ready', project), render('ready', done)].join('')
    // 这几个只在确认框、生成中、报余额不够时出现，首屏渲染不到；「生成全部 … 段」里的数是现算的。
    // 后面四个在工作台外面：侧栏的「创作」、左上角的「新建」、起始页的卡、顶栏的「删除此视频」，由 CreatePage 的用例钉住。
    const elsewhere = ['开始生成', '停止生成', '前往充值', '创作', '新建', '做一条带字幕的短视频', '删除此视频']
    for (const label of quoted.filter((entry) => !elsewhere.includes(entry))) expect(markup, label).toContain(label.replace(' … ', ' 2 '))
    expect(render('unsupported')).toContain(topic?.steps[0].extra?.[0].detail ?? '-')
  })
})
