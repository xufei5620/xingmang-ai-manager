import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { filterTutorialSections, TutorialPage } from './TutorialPage'

describe('TutorialPage', () => {
  it('ships the critical offline guides and support entry in the renderer bundle', () => {
    const markup = renderToStaticMarkup(
      <TutorialPage onNavigate={vi.fn()} onOpenSupport={vi.fn()} onOpenAccountCenter={vi.fn()} />,
    )

    expect(markup).toContain('教程')
    expect(markup).toContain('联系售后')
    expect(markup).toContain('首次使用')
    expect(markup).not.toContain('feishu')
    expect(markup).not.toContain('s4621e8xzb')
    expect(markup).not.toContain('第一次主要准备桌面端')
    expect(markup).not.toContain('已装好的工具会自动拿到对应 Key')
  })

  it('finds topics by Chinese terms and tool identifiers', () => {
    expect(filterTutorialSections('充值').map((section) => section.id)).toContain('account')
    expect(filterTutorialSections('npm').map((section) => section.id)).toContain('install')
    expect(filterTutorialSections('无限画布').map((section) => section.id)).toContain('chat-canvas')
    expect(filterTutorialSections('安装 PATH').map((section) => section.id)).toContain('install')
    expect(filterTutorialSections('不存在的关键词')).toEqual([])
  })
})
