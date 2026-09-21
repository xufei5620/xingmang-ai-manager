import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'

function render(updatableCount?: number): string {
  return renderToStaticMarkup(createElement(Shell, {
    activePage: 'home',
    platform: 'win',
    account: { signedIn: true, displayName: '星芒用户' },
    adapter: {},
    updatableCount,
    children: null,
  }))
}

describe('renderer-v2 sidebar update badge', () => {
  it('carries the pending update count into the 「你的工具」entry', () => {
    const markup = render(2)
    expect(markup).toContain('data-testid="nav-home-updates"')
    expect(markup).toContain('>2</small>')
    // 侧栏收起来只剩图标，角标里的数字就是唯一的说明，读屏也要能听到。
    expect(markup).toContain('aria-label="首页，2 个工具可更新"')
  })

  it('keeps the entry unchanged when nothing can be updated', () => {
    for (const markup of [render(0), render()]) {
      expect(markup).not.toContain('nav-home-updates')
      expect(markup).toContain('aria-label="首页"')
    }
  })
})
