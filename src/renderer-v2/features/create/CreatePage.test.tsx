import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { tutorialTopics } from '../../registry/tutorials'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { addVideoStudioShot, createVideoStudioProject } from '../video-studio/project'
import { CanvasProjectPane, CreateIntro, CreateStartCards, createVideoFilm, videoClipRefusal } from './CreatePage'

function nothing() { /* a static render never calls back */ }

function text(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function tutorialWords(id: string): string {
  const topic = tutorialTopics.find((entry) => entry.id === id)
  if (!topic) throw new Error(`no tutorial called ${id}`)
  return JSON.stringify(topic)
}

describe('the pieces of the create page that are its own', () => {
  it('offers a film and the canvas under the examples, in words a first-time customer can act on', () => {
    const html = renderToStaticMarkup(<CreateStartCards video onVideo={nothing} onCanvas={nothing} />)
    expect(html).toContain('data-testid="create-start"')
    expect(text(html)).toBe('一句话说不清的，从这里开始'
      + '做一条带字幕的短视频写一句想法，AI 写分镜、一段一段出，再拼成一条'
      + '在画布上一步步做多张图、精修、套模板，人物每一镜都长得一样也在这里开在大窗口里')
    expect(html.indexOf('data-testid="create-card-video"')).toBeLessThan(html.indexOf('data-testid="create-card-canvas"'))
    // 两张卡都是按钮：键盘走得到、读屏念得出。
    expect(html.match(/<button type="button" class="create-card"/g)).toHaveLength(2)
  })

  // 融合第 3 步：作品库里有视频、这个账号又能做视频时多第三张卡。
  it('adds a third card that joins clips already in the library, only when asked to', () => {
    const html = renderToStaticMarkup(<CreateStartCards video clips onVideo={nothing} onCanvas={nothing} onClips={nothing} />)
    expect(html.match(/<button type="button" class="create-card"/g)).toHaveLength(3)
    expect(html.indexOf('data-testid="create-card-canvas"')).toBeLessThan(html.indexOf('data-testid="create-card-clips"'))
    expect(text(html)).toContain('用已有片段合成视频从作品库选择片段，添加字幕和配乐，在本机合成，不产生费用')
    // 没人接这张卡的地方不出它，免得点了没反应。
    expect(renderToStaticMarkup(<CreateStartCards video clips onVideo={nothing} onCanvas={nothing} />)).not.toContain('create-card-clips')
    expect(renderToStaticMarkup(<CreateStartCards video clips={false} onVideo={nothing} onCanvas={nothing} onClips={nothing} />)).not.toContain('create-card-clips')
  })

  it('leaves the film card out for an account that cannot start a film right now, and keeps the canvas', () => {
    const html = renderToStaticMarkup(<CreateStartCards video={false} onVideo={nothing} onCanvas={nothing} />)
    expect(html).not.toContain('create-card-video')
    expect(html).not.toContain('做一条带字幕的短视频')
    expect(html).toContain('data-testid="create-card-canvas"')
  })

  it('shows a canvas project as its name, when it was last changed, and one button that opens the canvas', () => {
    const now = new Date(2026, 10, 20, 15, 0).getTime()
    const html = renderToStaticMarkup(<CanvasProjectPane project={{ id: 'p1', name: '双 11 主图', updatedAt: new Date(2026, 10, 19, 21, 14).getTime() }} opening={false} onOpen={nothing} now={now} />)
    expect(html).toContain('data-testid="create-canvas-pane"')
    expect(html).toContain('<strong data-testid="create-canvas-name">双 11 主图</strong>')
    expect(html).toContain('<span data-testid="create-canvas-time">画布项目 · 昨天 21:14 改过</span>')
    expect(html).toContain('data-testid="create-canvas-open"')
    expect(text(html)).toContain('打开画布')
    expect(text(html)).toContain('画布开在一个大窗口里，可以一边让它跑，一边回这里做别的。')
    expect(text(html)).toContain('改名、复制、归档、删除在画布窗口的「项目中心」里做。')
    // 这一步没有「放进画布」，也不在这里改名、删除画布项目。
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toContain('放进画布')
  })

  it('writes a canvas project name as plain text, whatever the canvas stored', () => {
    const html = renderToStaticMarkup(<CanvasProjectPane project={{ id: 'p1', name: '<img src=x onerror=alert(1)>', updatedAt: 0 }} opening={false} onOpen={nothing} />)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // 没有时间的项目不编一个时间出来。
    expect(html).toContain('<span data-testid="create-canvas-time">画布项目</span>')
  })

  it('marks the open button busy while the canvas window is being opened', () => {
    const html = renderToStaticMarkup(<CanvasProjectPane project={{ id: 'p1', name: '海报', updatedAt: 1 }} opening onOpen={nothing} />)
    expect(html).toMatch(/data-testid="create-canvas-open"[^>]*aria-busy="true"|aria-busy="true"[^>]*data-testid="create-canvas-open"/)
  })

  it('says once that the three pages were merged, and nothing before that is decided or after it is closed', () => {
    const shown = renderToStaticMarkup(<CreateIntro state="shown" ready hasEarlierWork onDecide={nothing} onDismiss={nothing} />)
    expect(shown).toContain('data-testid="create-intro"')
    expect(text(shown)).toBe('聊天、画布、视频剪辑合到这一页了以前的对话、画布项目、视频草稿都在左边这一列，一个没少。生成的图片和视频可在左下角「作品库」中查看。')
    expect(shown).toContain('<button')
    expect(renderToStaticMarkup(<CreateIntro state="undecided" ready hasEarlierWork onDecide={nothing} onDismiss={nothing} />)).toBe('')
    expect(renderToStaticMarkup(<CreateIntro state="gone" ready hasEarlierWork onDecide={nothing} onDismiss={nothing} />)).toBe('')
  })

  // 教程里带「」的按钮名要和界面上的一字不差：视频教程从「创作」进，引的是这一页的卡。
  it('carries the card title the video tutorial tells the customer to click', () => {
    const html = renderToStaticMarkup(<CreateStartCards video onVideo={nothing} onCanvas={nothing} />)
    const words = tutorialWords('video')
    expect(words).toContain('做一条带字幕的短视频')
    expect(html).toContain('<strong>做一条带字幕的短视频</strong>')
    expect(words).not.toContain('左侧视频剪辑')
    expect(tutorialWords('canvas')).toContain('在画布上一步步做')
    expect(html).toContain('<strong>在画布上一步步做</strong>')
  })
})

describe('a film in the 添加到视频 menu', () => {
  function film(shots: number, name?: string) {
    let project = createVideoStudioProject()
    for (let index = 0; index < shots; index += 1) project = addVideoStudioShot(project, () => `shot-${index}`)
    return { id: 'film-1', updatedAt: 1, project, ...(name ? { name } : {}) }
  }

  it('reads as the name and how many shots it has', () => {
    expect(createVideoFilm(film(4, '橘猫回家'))).toEqual({ id: 'film-1', title: '橘猫回家', detail: '4 个镜头' })
    expect(createVideoFilm(film(0))).toEqual({ id: 'film-1', title: '新视频', detail: '还没写分镜' })
  })

  it('is greyed out with the reason once every shot slot is taken', () => {
    const full = createVideoFilm(film(videoStudioPlanLimits.maximumShots, '新品口红'))
    expect(full).toEqual({ id: 'film-1', title: '新品口红', detail: `${videoStudioPlanLimits.maximumShots} 个镜头，已满`, full: true })
    expect(createVideoFilm(film(videoStudioPlanLimits.maximumShots - 1))).not.toHaveProperty('full')
  })

  it('takes a clip unless it is gone, busy, or full', () => {
    expect(videoClipRefusal(film(4, '橘猫回家'), false, false)).toBeNull()
    expect(videoClipRefusal(null, false, false)).toBe('该视频已删除，请选择其他视频。')
    // The open workbench hangs finished work back on its own copy: a write from outside while it works would be lost.
    expect(videoClipRefusal(film(4, '橘猫回家'), false, true)).toBe('「橘猫回家」正在进行其他操作（编写分镜、生成或合成），请待其完成后再添加。')
    expect(videoClipRefusal(film(videoStudioPlanLimits.maximumShots, '新品口红'), false, false)).toBe('「新品口红」的镜头数量已达上限，请选择其他视频，或新建视频。')
  })

  it('does not ask whether a film made for this clip is full', () => {
    // 新建的那一条照最近一条的设置起，里面的镜头会整份换成这一段：看它原来几个镜头没有意义。
    expect(videoClipRefusal(film(videoStudioPlanLimits.maximumShots), true, false)).toBeNull()
  })
})
