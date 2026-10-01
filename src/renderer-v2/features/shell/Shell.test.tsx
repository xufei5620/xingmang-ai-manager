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

describe('renderer-v2 shell keyboard landmarks', () => {
  it('offers a skip link to a focusable main region and a polite page announcement', () => {
    const markup = render()
    expect(markup).toMatch(/<aside[^>]*data-testid="sidebar"[^>]*><a class="v2-skip-link" href="#v2-main"[^>]*>跳到正文<\/a>/)
    expect(markup).toMatch(/<main[^>]*id="v2-main"[^>]*tabindex="-1"/)
    expect(markup).toMatch(/<p class="v2-visually-hidden" role="status" aria-live="polite"[^>]*><\/p>/)
  })
})

describe('renderer-v2 sidebar account source', () => {
  it('names which account the user is signed in with', () => {
    const markup = renderToStaticMarkup(createElement(Shell, {
      activePage: 'home',
      platform: 'win',
      account: { signedIn: true, displayName: '星芒用户', sourceLabel: '历史账号' },
      adapter: {},
      children: null,
    }))
    expect(markup).toContain('<small>历史账号</small>')
    expect(render()).toContain('<small>星芒账号</small>')
  })
})

describe('renderer-v2 status bar account label', () => {
  function statusbar(account: { signedIn: boolean; displayName?: string; email?: string }): string {
    const markup = renderToStaticMarkup(createElement(Shell, { activePage: 'home', platform: 'mac', account, adapter: {}, children: null }))
    return markup.slice(markup.indexOf('data-testid="shell-statusbar"'))
  }

  it('says the same thing as the sidebar card while a saved login waits for a retry', () => {
    // 开机恢复联不上时左下角写「暂时连不上，登录还在」，状态栏不能同时写「未登录」。
    const markup = statusbar({ signedIn: false, displayName: '暂时连不上，登录还在', email: '稍后自动重试，不用重新登录' })
    expect(markup).toContain('暂时连不上，登录还在')
    expect(markup).not.toContain('未登录')
  })

  it('keeps 未登录 and 已登录 for the plain states', () => {
    expect(statusbar({ signedIn: false })).toContain('未登录')
    expect(statusbar({ signedIn: true, displayName: '星芒用户' })).toContain('已登录 星芒用户')
  })
})
