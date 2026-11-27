import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatStartModes } from './ChatPage'
import { chatModeNames, imageModeFilesMessage, modeFilesMessage, videoModeFilesMessage } from './state'

function nothing() { /* a static render never calls back */ }

function text(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

// 全面方案第 30 件方案甲（yoyo 11-28 回「功能名入口」）：起始页标题下面三个入口，名字和输入框下的切换是同一套。
describe('the entries under the start page title', () => {
  it('offers pictures, video and chat in that order, each a name and a few keywords', () => {
    const html = renderToStaticMarkup(<ChatStartModes mode="text" video onSelect={nothing} />)
    expect(html).toContain('data-testid="chat-start-modes"')
    expect([...html.matchAll(/data-testid="(chat-start-mode-[a-z]+)"/g)].map((match) => match[1])).toEqual(['chat-start-mode-image', 'chat-start-mode-video', 'chat-start-mode-text'])
    expect(text(html)).toBe('图片生成描述生成 · 参考图编辑' + '视频生成描述生成 · 图片转视频' + '智能对话问答 · 写作 · 翻译 · 编程')
    // 三个都是按钮：键盘走得到、读屏念得出按没按着。
    expect(html.match(/<button type="button" class="chat-start-mode" aria-pressed="(true|false)"/g)).toHaveLength(3)
  })

  it('shows the mode the box is in as the pressed one', () => {
    for (const mode of ['text', 'image', 'video'] as const) {
      const html = renderToStaticMarkup(<ChatStartModes mode={mode} video onSelect={nothing} />)
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
      expect(html).toMatch(new RegExp(`aria-pressed="true" data-testid="chat-start-mode-${mode}"`))
    }
  })

  it('leaves the video entry out for an account that cannot make video right now', () => {
    const html = renderToStaticMarkup(<ChatStartModes mode="text" video={false} onSelect={nothing} />)
    expect(html).not.toContain('chat-start-mode-video')
    expect(html).not.toContain('视频生成')
    expect(html.match(/<button/g)).toHaveLength(2)
  })

  it('uses the same names as the switch below the box, and the file notes point at the chat one by that name', () => {
    expect(chatModeNames).toEqual({ text: '智能对话', image: '图片生成', video: '视频生成' })
    expect(imageModeFilesMessage).toBe('生成图片时不支持附带文件，请先移除文件，或切换回「智能对话」')
    expect(videoModeFilesMessage).toBe('生成视频时无法附带文件，请先移除文件，或切换回「智能对话」')
    expect(modeFilesMessage('image')).toBe(imageModeFilesMessage)
  })
})
