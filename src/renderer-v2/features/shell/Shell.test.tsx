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

function renderAccount(account: Parameters<typeof Shell>[0]['account'], adapter: Parameters<typeof Shell>[0]['adapter'] = {}): string {
  const markup = renderToStaticMarkup(createElement(Shell, { activePage: 'home', platform: 'win', account, adapter, children: null }))
  return markup.slice(markup.indexOf('data-testid="account-entry"'), markup.indexOf('</aside>'))
}

describe('renderer-v2 sidebar account card', () => {
  it('tags a historical account after its name and leaves the default account untagged', () => {
    expect(renderAccount({ signedIn: true, displayName: '星芒用户', sourceTag: '历史账号' })).toContain('data-testid="sidebar-account-tag">历史账号</small>')
    const plain = renderAccount({ signedIn: true, displayName: '星芒用户', balance: '$12.40' })
    expect(plain).not.toContain('sidebar-account-tag')
    expect(plain).not.toContain('星芒账号')
  })

  it('shows the amount without a 余额 label and keeps the refresh and top-up buttons', () => {
    const markup = renderAccount({ signedIn: true, displayName: '星芒用户', balance: '$12.40' }, { refreshBalance: () => undefined })
    expect(markup).toContain('<strong>$12.40</strong>')
    expect(markup).not.toContain('<small>余额</small>')
    expect(markup).toContain('data-testid="sidebar-balance-refresh"')
    expect(markup).toContain('>充值<')
  })

  it('writes a dash with a hint when the balance could not be read, and a placeholder while it is first read', () => {
    const unread = renderAccount({ signedIn: true, displayName: '星芒用户' })
    expect(unread).toContain('title="余额暂时没有读到，点刷新再试"')
    expect(unread).toContain('>—</strong>')
    expect(unread).not.toContain('暂未读到</strong>')
    expect(renderAccount({ signedIn: true, displayName: '星芒用户', balanceLoading: true })).toContain('sidebar-balance-placeholder')
  })

  it('shows a blank spinning avatar and a placeholder amount while the saved login is restored', () => {
    const restoring = renderAccount({ signedIn: false, displayName: '正在恢复登录', email: '网络慢时要多等一会儿', restoring: 'pending' })
    expect(restoring).toContain('data-testid="sidebar-account-placeholder"')
    expect(restoring).toContain('xm-spin')
    expect(restoring).not.toContain('v2-local-avatar')
    expect(restoring).toContain('网络慢时要多等一会儿')
    expect(restoring).toContain('sidebar-balance-placeholder')
    const retrying = renderAccount({ signedIn: false, displayName: '暂时连不上，登录还在', email: '稍后自动重试，不用重新登录', restoring: 'retrying' })
    expect(retrying).toContain('data-testid="sidebar-account-placeholder"')
    expect(retrying).not.toContain('xm-spin')
  })

  it('keeps the signed-out note', () => {
    const markup = renderAccount({ signedIn: false })
    expect(markup).toContain('未登录')
    expect(markup).toContain('登录后自动配 Key')
  })
})

describe('renderer-v2 sidebar pinned navigation', () => {
  it('pins More right above Settings, outside the scrolling list', () => {
    const markup = render()
    const scroll = markup.slice(markup.indexOf('data-testid="sidebar-scroll"'), markup.indexOf('data-testid="sidebar-pinned"'))
    const pinned = markup.slice(markup.indexOf('data-testid="sidebar-pinned"'), markup.indexOf('data-testid="account-entry"'))
    expect(scroll).not.toContain('nav-more')
    expect(pinned.indexOf('data-testid="nav-more"')).toBeLessThan(pinned.indexOf('data-testid="nav-settings"'))
  })

  it('names the search by what it finds', () => {
    expect(render()).toContain('<span>搜功能、设置或教程…</span>')
    expect(render()).not.toContain('搜索、打开、跳转')
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

describe('renderer-v2 sidebar pages per computer', () => {
  it('drops game acceleration from the sidebar when this computer has none (Linux)', () => {
    const linux = renderToStaticMarkup(createElement(Shell, {
      activePage: 'home',
      platform: 'linux',
      account: { signedIn: true, displayName: '星芒用户' },
      adapter: { pageVisible: (page) => page !== 'acceleration' },
      children: null,
    }))
    expect(linux).not.toContain('data-testid="nav-acceleration"')
    expect(linux).toContain('data-testid="nav-home"')
    expect(linux).toContain('data-testid="nav-tutorial"')
  })

  it('keeps every page when nothing says otherwise', () => {
    expect(render()).toContain('data-testid="nav-acceleration"')
  })
})
