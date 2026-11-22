import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AiLibraryEntry, AiVideoClip } from '../../../../electron/ipc-contract'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import type { VideoStudioItem } from '../video-studio/library'
import { createVideoStudioProject } from '../video-studio/project'
import { CreateLibraryPane, LibraryDetail, LibraryPicker, type CreateLibraryActions } from './CreateLibrary'
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
  openFolder: nothing, openConversation: nothing, openFilm: nothing, reuseImage: nothing, animateImage: nothing, saveImage: nothing, saveVideo: nothing, openVideo: nothing, addClip: nothing,
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
    expect(text(html)).toContain('对话与视频中生成的图片、片段和成片均保存在此处，文件位于本机的 AI 作品文件夹。')
    expect(html).not.toContain('create-library-more')
    // 这一步没有「放进画布」。
    expect(html).not.toContain('放进画布')
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

  function detail(entry: AiLibraryEntry, origin: LibraryOrigin | undefined, more: { film?: boolean, videoReady?: boolean } = {}) {
    return renderToStaticMarkup(<LibraryDetail entry={entry} origin={origin} film={more.film ?? false} videoReady={more.videoReady ?? true}
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
