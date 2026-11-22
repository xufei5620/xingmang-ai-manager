import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AiLibraryEntry, AiVideoClip } from '../../../../electron/ipc-contract'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import type { VideoStudioItem } from '../video-studio/library'
import { createVideoStudioProject } from '../video-studio/project'
import { CanvasProjectWorksView, CreateLibraryPane, LibraryDetail, LibraryPicker, type CreateLibraryActions } from './CreateLibrary'
import type { LibraryOrigin } from './library'
import type { CreateLibrary } from './useCreateLibrary'

// 只渲染首屏：effect 不跑，这里不会读作品库，也不会去量视频。
function unused(): never { throw new Error('not expected during a static render') }
function nothing() { /* a static render never calls back */ }

function id(seed: string): string {
  return seed.padEnd(43, '0').slice(0, 43)
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function image(seed: string, more: Partial<AiLibraryEntry> = {}): AiLibraryEntry {
  return { assetId: id(seed), mediaType: 'image', createdAt: '2026-11-21T03:00:00.000Z', mimeType: 'image/png', fileName: `xingmang-${seed}.png`, ...more }
}

function video(seed: string, more: Partial<AiLibraryEntry> = {}): AiLibraryEntry {
  return { assetId: id(seed), mediaType: 'video', createdAt: '2026-11-21T02:00:00.000Z', fileName: `xingmang-${seed}.mp4`, ...more }
}

function clip(seed: string, durationSeconds = 5): AiVideoClip {
  return { assetId: id(seed), thumbnailUrl: assetThumbnailUrl(id(seed), 'video'), width: 1280, height: 720, durationSeconds }
}

const actions: CreateLibraryActions = {
  openFolder: nothing, openConversation: nothing, openFilm: nothing, openCanvasProject: nothing, reuseImage: nothing, animateImage: nothing, saveImage: nothing, saveVideo: nothing, openVideo: nothing, addClip: nothing,
}

function library(more: Partial<CreateLibrary> = {}): CreateLibrary {
  return {
    status: 'ready', counts: { image: 1, video: 2, film: 1 }, kind: 'all', search: '', items: [], total: 0, hasMore: false, loadingMore: false,
    setKind: nothing, setSearch: nothing, loadMore: nothing, refresh: nothing, ...more,
  }
}

// 一条视频：第一镜的片段和上一次拼好的成片都在作品库里。
const film: VideoStudioItem = {
  id: 'film-1', name: '橘猫回家', updatedAt: 1,
  project: { ...createVideoStudioProject(), shots: [{ id: 's1', prompt: '雨夜街头的橘猫', caption: '', status: 'done', clip: clip('shot') }], exported: clip('film', 75) },
}

function pane(state: CreateLibrary, films: readonly VideoStudioItem[] = [film]) {
  return renderToStaticMarkup(<CreateLibraryPane library={state} conversations={[]} films={films} videoReady videoFilms={[]} actions={actions} />)
}

describe('the library on the create page', () => {
  it('lists every piece as a tile with where it came from, newest first as the main process gave them', () => {
    const items = [image('poster', { name: '双 11 主图' }), video('film'), video('shot')]
    const html = pane(library({ items, total: 3 }))
    expect(html).toContain('data-testid="create-library-pane"')
    expect(html).toContain('<strong>作品库</strong>')
    expect(html).toMatch(/data-testid="create-library-folder"[^>]*>[^]*?打开文件夹/)
    // 筛选那一排带着各类的数：「全部」是图片加视频，成片不重复算。
    expect(text(html)).toContain('全部3图片1视频片段1成片1')
    expect(html).toContain('placeholder="按描述搜索"')
    const order = [...html.matchAll(/data-testid="create-library-item-([^"]+)"/g)].map((match) => match[1])
    expect(order).toEqual(items.map((item) => item.assetId))
    // 小图走缩略图那个地址，不读原图、不读整段视频。
    expect(html).toContain(`src="xingmang-asset://thumb/v2/image/${id('poster')}"`)
    expect(html).toContain(`src="xingmang-asset://thumb/v2/video/${id('film')}"`)
    expect(html).not.toContain('xingmang-asset://video/')
    // 成片的格子角上写「成片」和多长，镜头里的片段只写多长。
    expect(html).toMatch(new RegExp(`data-kind="film"[^>]*data-testid="create-library-item-${id('film')}"[^]*?成片 1:15`))
    expect(html).toMatch(new RegExp(`data-kind="video"[^>]*data-testid="create-library-item-${id('shot')}"[^]*?0:05`))
    expect(text(html)).toContain('对话、视频和画布中生成的图片、片段和成片均显示在此处。对话和视频的文件位于本机的 AI 作品文件夹，画布的文件位于各项目的工作文件夹。')
    expect(html).not.toContain('create-library-more')
    // 「放进画布」没有做。
    expect(html).not.toContain('放进画布')
  })

  // 融合第 5 步：画布项目里生成的跟别的排在一起，小字写「画布」。
  it('lists what a canvas project made among the rest, marked as the canvas\'s', () => {
    const project = { projectId: '11111111-1111-4111-8111-111111111111', projectName: '<b>双十一</b>主图' }
    const html = pane(library({ items: [image('poster', { prompt: '一张主图', canvas: project }), video('shot')], total: 2 }))
    expect(html).toMatch(new RegExp(`aria-label="一张主图"[^>]*data-testid="create-library-item-${id('poster')}"[^]*?<small>画布 · [^<]+</small>`))
    expect(html).toMatch(new RegExp(`data-testid="create-library-item-${id('shot')}"[^]*?<small>视频 · [^<]+</small>`))
    // 项目的名字和编号不写在格子上。
    expect(html).not.toContain('双十一')
    expect(html).not.toContain(project.projectId)
  })

  it('offers more only while the main process says there is more', () => {
    const html = pane(library({ items: [image('a')], total: 30, hasMore: true }))
    expect(html).toMatch(/data-testid="create-library-more"[^>]*>[^]*?加载更多/)
  })

  it('says in formal words that nothing is here yet, that a class is empty, or that a search found nothing', () => {
    expect(text(pane(library({ counts: { image: 0, video: 0, film: 0 } })))).toContain('暂无作品。生成的图片和视频将显示在此处。')
    expect(text(pane(library({ kind: 'film' })))).toContain('该分类下暂无作品。')
    expect(text(pane(library({ search: '海报' })))).toContain('未找到与「海报」相关的作品')
    expect(pane(library())).toContain('data-testid="create-library-empty"')
  })

  it('shows a placeholder while the first page is read and a retry when it could not be read', () => {
    const loading = pane(library({ status: 'loading', counts: null }))
    expect(loading).toContain('data-testid="create-library-loading"')
    expect(loading).not.toContain('create-library-grid')
    // 还没读到各类的数时，筛选那一排不写数。
    expect(text(loading)).toContain('全部图片视频片段成片')
    const unreadable = pane(library({ status: 'unreadable', counts: null }))
    expect(unreadable).toMatch(/role="alert"[^>]*data-testid="create-library-unreadable"/)
    expect(text(unreadable)).toContain('作品库读取失败，请稍后重试')
    expect(unreadable).toMatch(/data-testid="create-library-retry"[^>]*>[^]*?重试/)
  })

  it('writes a name the canvas stored as plain text', () => {
    const html = pane(library({ items: [image('x', { name: '<img src=x onerror=alert(1)>' })], total: 1 }))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('one piece opened from the library', () => {
  const chatOrigin: LibraryOrigin = { from: 'chat', id: 'c1', title: '橘猫的一天', prompt: '一只橘猫坐在窗台上', width: 1024, height: 1024 }

  function detail(entry: AiLibraryEntry, origin: LibraryOrigin | undefined, more: { film?: boolean, videoReady?: boolean, originLink?: boolean } = {}) {
    return renderToStaticMarkup(<LibraryDetail entry={entry} origin={origin} film={more.film ?? false} videoReady={more.videoReady ?? true} originLink={more.originLink}
      videoFilms={[{ id: 'film-1', title: '橘猫回家', detail: '1 个镜头' }]} actions={actions} onClose={nothing} />)
  }

  it('shows a picture at full size with where it came from and what it can be used for', () => {
    const html = detail(image('cat'), chatOrigin)
    expect(html).toContain('data-testid="create-library-detail"')
    expect(html).toContain(`src="xingmang-asset://image/${id('cat')}"`)
    expect(text(html)).toContain('一只橘猫坐在窗台上')
    expect(text(html)).toMatch(/出自对话「橘猫的一天」 · .* · 1024 × 1024/)
    expect(html).toMatch(/data-testid="create-library-origin"[^>]*>[^]*?查看对话/)
    expect(html).toMatch(/data-testid="create-library-reuse"[^>]*>[^]*?基于此图继续编辑/)
    expect(html).toMatch(/data-testid="create-library-animate"[^>]*>[^]*?用此图生成视频/)
    expect(html).toMatch(/data-testid="create-library-save-image"[^>]*>[^]*?另存图片/)
    expect(html).not.toContain('放进画布')
  })

  it('leaves out making a video from a picture for an account that cannot make one now', () => {
    const html = detail(image('cat'), chatOrigin, { videoReady: false })
    expect(html).not.toContain('create-library-animate')
    expect(html).toContain('data-testid="create-library-reuse"')
  })

  it('says nothing about where a piece came from when no conversation or film remembers it', () => {
    const html = detail(image('lost'), undefined)
    expect(html).not.toContain('create-library-origin')
    expect(text(html)).not.toContain('出自')
    // 标题退到类别。
    expect(html).toContain('>图片</h2>')
  })

  it('plays a video in the page and offers to add it to a film, save it or open it in the player', () => {
    const origin: LibraryOrigin = { from: 'video', id: 'film-1', title: '橘猫回家', prompt: '', clip: clip('film', 75) }
    const html = detail(video('film'), origin, { film: true })
    expect(html).toMatch(new RegExp(`<video[^>]*src="xingmang-asset://video/${id('film')}"[^>]*controls`))
    expect(html).toContain(`poster="xingmang-asset://thumb/v2/video/${id('film')}"`)
    expect(html).toContain('>橘猫回家</h2>')
    expect(text(html)).toMatch(/出自视频「橘猫回家」 · .* · 1280 × 720/)
    expect(html).toMatch(/data-testid="create-library-origin"[^>]*>[^]*?查看视频/)
    expect(html).toMatch(/data-testid="create-library-compose"[^>]*>[^]*?添加到视频/)
    expect(html).toMatch(/data-testid="create-library-save-video"[^>]*>[^]*?另存视频/)
    expect(html).toMatch(/data-testid="create-library-open-video"[^>]*>[^]*?用播放器打开/)
    expect(html).not.toContain('create-library-reuse')
    const cannot = detail(video('film'), origin, { film: true, videoReady: false })
    expect(cannot).not.toContain('create-library-compose')
    expect(cannot).toContain('data-testid="create-library-save-video"')
  })
})

describe('a canvas project\'s work opened from the library', () => {
  const made: LibraryOrigin = { from: 'canvas', id: '11111111-1111-4111-8111-111111111111', title: '<b>双十一</b>主图', prompt: '一张主图' }

  function detail(entry: AiLibraryEntry, origin: LibraryOrigin, originLink?: boolean) {
    return renderToStaticMarkup(<LibraryDetail entry={entry} origin={origin} film={false} originLink={originLink} videoReady videoFilms={[]} actions={actions} onClose={nothing} />)
  }

  it('says which project made it, in plain text, and offers the same things as any other picture or video', () => {
    const html = detail(image('poster'), made)
    expect(text(html)).toMatch(/出自画布项目「&lt;b&gt;双十一&lt;\/b&gt;主图」 · /)
    expect(html).not.toContain('<b>双十一</b>')
    expect(html).toMatch(/data-testid="create-library-origin"[^>]*>[^]*?查看画布项目/)
    expect(html).toContain(`src="xingmang-asset://image/${id('poster')}"`)
    for (const testId of ['create-library-reuse', 'create-library-animate', 'create-library-save-image']) expect(html).toContain(`data-testid="${testId}"`)
    const clipHtml = detail(video('walk'), { ...made, title: '双十一主图' })
    expect(clipHtml).toMatch(new RegExp(`<video[^>]*src="xingmang-asset://video/${id('walk')}"`))
    for (const testId of ['create-library-compose', 'create-library-save-video', 'create-library-open-video']) expect(clipHtml).toContain(`data-testid="${testId}"`)
    // 「放进画布」没有做，从这里也不直接开画布窗口。
    expect(html).not.toContain('放进画布')
    expect(text(html)).not.toContain('打开画布')
  })

  it('says a thing a project only holds was used there, and drops the link where the project is already open', () => {
    const html = detail(image('held'), { ...made, used: true, title: '双十一主图', prompt: '' })
    expect(text(html)).toMatch(/用于画布项目「双十一主图」 · /)
    expect(text(html)).not.toContain('出自')
    const inside = detail(image('poster'), { ...made, title: '双十一主图' }, false)
    expect(text(inside)).toMatch(/出自画布项目「双十一主图」 · /)
    expect(inside).not.toContain('create-library-origin')
  })
})

describe('the works under an opened canvas project', () => {
  const project = { projectId: '11111111-1111-4111-8111-111111111111', projectName: '双十一主图' }

  function works(state: CreateLibrary) {
    return renderToStaticMarkup(<CanvasProjectWorksView library={state} conversations={[]} films={[]} videoReady videoFilms={[]} actions={actions} />)
  }

  it('lists what the project made as the same tiles as the library, with how many there are', () => {
    const items = [image('poster', { canvas: project }), video('walk', { canvas: project })]
    const html = works(library({ items, total: 12, hasMore: true }))
    expect(html).toMatch(/<section[^>]*aria-label="此项目中的作品"[^>]*data-testid="create-canvas-works"/)
    expect(text(html)).toContain('此项目中的作品12 个')
    expect([...html.matchAll(/data-testid="create-library-item-([^"]+)"/g)].map((match) => match[1])).toEqual(items.map((item) => item.assetId))
    expect(html).toContain(`src="xingmang-asset://thumb/v2/image/${id('poster')}"`)
    expect(html).toMatch(/data-testid="create-canvas-works-more"[^>]*>[^]*?加载更多/)
    // 这里不筛选、不搜索，也没有选择框里的勾选。
    expect(html).not.toContain('create-library-search')
    expect(html).not.toContain('aria-pressed')
    expect(works(library({ items, total: 2 }))).not.toContain('create-canvas-works-more')
  })

  it('says in formal words that the project has made nothing yet, and writes no count then', () => {
    const html = works(library())
    expect(html).toContain('data-testid="create-canvas-works-empty"')
    expect(text(html)).toBe('此项目中的作品此项目暂无作品。在画布中生成的图片和视频将显示在此处。')
  })

  it('shows a placeholder while it reads and a retry when it could not be read', () => {
    const loading = works(library({ status: 'loading', counts: null }))
    expect(loading).toContain('data-testid="create-canvas-works-loading"')
    expect(loading).not.toContain('create-canvas-works-count')
    const unreadable = works(library({ status: 'unreadable', counts: null }))
    expect(unreadable).toMatch(/role="alert"[^>]*data-testid="create-canvas-works-unreadable"/)
    expect(text(unreadable)).toContain('作品读取失败，请稍后重试')
    expect(unreadable).toMatch(/data-testid="create-canvas-works-retry"[^>]*>[^]*?重试/)
  })
})

describe('picking from the library', () => {
  const bridge = { listAiLibrary: unused }

  it('asks for one picture, or for up to so many clips in the order picked, and waits with the confirm button off', () => {
    const one = renderToStaticMarkup(<LibraryPicker bridge={bridge} kind="image" limit={1} conversations={[]} films={[]} onPick={nothing} onClose={nothing} />)
    expect(one).toContain('data-testid="create-library-picker"')
    expect(one).toContain('>选择图片</h2>')
    expect(text(one)).not.toContain('最多选择')
    // 只挑一类，不出「全部 / 图片 / 视频 / 成片」那一排。
    expect(one).not.toContain('create-library-picker-kinds')
    expect(one).toMatch(/data-testid="create-library-picker-ok"[^>]*disabled=""|disabled=""[^>]*data-testid="create-library-picker-ok"/)
    expect(one).toMatch(/data-testid="create-library-picker-cancel"[^>]*>[^]*?取消/)
    const many = renderToStaticMarkup(<LibraryPicker bridge={bridge} kind="video" limit={12} conversations={[]} films={[]} onPick={nothing} onClose={nothing} />)
    expect(many).toContain('>选择片段</h2>')
    expect(text(many)).toContain('最多选择 12 段，按选择顺序排列。')
  })
})
