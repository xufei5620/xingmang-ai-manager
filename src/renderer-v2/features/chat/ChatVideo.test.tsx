import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import { ChatVideoClip, ChatVideoPending } from './ChatVideo'

const assetId = 'v'.repeat(43)
const clip: AiVideoClip = { assetId, thumbnailUrl: assetThumbnailUrl(assetId, 'video'), width: 1280, height: 720, durationSeconds: 5 }

function nothing() { /* a static render never calls back */ }
function text(html: string): string { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }

describe('ChatVideoPending', () => {
  it('shows how far the clip is, the wait hint and a stop button', () => {
    const html = renderToStaticMarkup(<ChatVideoPending progress={{ stage: 'processing', value: 42 }} stopping={false} onStop={nothing} />)
    expect(text(html)).toContain('正在生成视频 42%')
    expect(text(html)).toContain('生成需要几分钟，可先进行其他操作，完成后将保留在此处')
    expect(html).toContain('data-testid="chat-video-stop"')
    expect(html).toContain('data-testid="chat-video-progress"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('role="status"')
  })

  it('has no bar before the first progress arrives or while the file is being saved', () => {
    expect(renderToStaticMarkup(<ChatVideoPending stopping={false} onStop={nothing} />)).not.toContain('chat-video-progress')
    const saving = renderToStaticMarkup(<ChatVideoPending progress={{ stage: 'saving', value: 100 }} stopping={false} onStop={nothing} />)
    expect(saving).not.toContain('chat-video-progress')
    expect(text(saving)).toContain('正在保存')
  })
})

describe('ChatVideoClip', () => {
  const films = [{ id: 'film-1', title: '橘猫回家', detail: '4 个镜头' }, { id: 'film-2', title: '新品口红', detail: '12 个镜头，已满', full: true }]

  it('shows only the first frame until play is pressed, so a screen of clips reads no video files', () => {
    const html = renderToStaticMarkup(<ChatVideoClip clip={clip} films={films} onCompose={nothing} onSave={nothing} onOpen={nothing} />)
    expect(html).not.toContain('<video')
    expect(html).not.toContain(`xingmang-asset://video/${assetId}`)
    expect(html).toContain(`src="${clip.thumbnailUrl}"`)
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('data-testid="chat-video-play"')
    expect(html).toContain('aria-label="播放"')
    expect(text(html)).toContain('0:05')
    expect(text(html)).toContain('1280 × 720 · 5 秒')
  })

  it('offers 添加到视频, save and the more menu under a finished clip', () => {
    const html = renderToStaticMarkup(<ChatVideoClip clip={clip} films={films} onCompose={nothing} onSave={nothing} onOpen={nothing} />)
    expect(text(html)).toContain('添加到视频')
    expect(html).toContain('data-testid="chat-video-compose"')
    expect(html).toContain('data-testid="chat-video-save"')
    expect(html).toContain('aria-label="另存视频"')
    expect(html).toContain('data-testid="chat-video-menu"')
  })

  it('leaves 添加到视频 out when this account cannot make videos, and keeps save and open', () => {
    const html = renderToStaticMarkup(<ChatVideoClip clip={clip} onCompose={nothing} onSave={nothing} onOpen={nothing} />)
    expect(html).not.toContain('chat-video-compose')
    expect(html).toContain('data-testid="chat-video-save"')
    expect(html).toContain('data-testid="chat-video-menu"')
  })

  it('marks a portrait clip so its frame stands upright, and writes nothing it was not given', () => {
    const portrait = renderToStaticMarkup(<ChatVideoClip clip={{ ...clip, width: 720, height: 1280 }} onCompose={nothing} onSave={nothing} onOpen={nothing} />)
    expect(portrait).toContain('data-portrait="true"')
    const bare = renderToStaticMarkup(<ChatVideoClip clip={{ assetId, thumbnailUrl: clip.thumbnailUrl }} onCompose={nothing} onSave={nothing} onOpen={nothing} />)
    expect(bare).not.toContain('data-portrait')
    expect(bare).not.toContain('<small')
    expect(bare).not.toContain('<b>')
  })
})
