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

  it('labels the amount 余额 and offers the refresh button only after a read failed', () => {
    const markup = renderAccount({ signedIn: true, displayName: '星芒用户', balance: '$12.40' }, { refreshBalance: () => undefined })
    expect(markup).toContain('<span>余额</span><strong>$12.40</strong>')
    expect(markup).toContain('aria-label="个人中心：星芒用户，余额 $12.40"')
    expect(markup).not.toContain('sidebar-balance-refresh')
    // 充值挪到侧栏那一行，卡片里不再有自己的「充值」「切换账号」键。
    expect(markup).not.toContain('>充值<')
    expect(markup).not.toContain('切换账号')
    const failed = renderAccount({ signedIn: true, displayName: '星芒用户', balance: '$12.40', balanceError: '网络暂时不可用' }, { refreshBalance: () => undefined })
    expect(failed).toContain('data-testid="sidebar-balance-refresh"')
  })

  it('shows the plan, the runway meter and the days line, and turns them amber when money runs low', () => {
    const plenty = renderAccount({ signedIn: true, displayName: '星芒用户', balance: '$80.00', plan: '按量付费', runway: { usableUsd: 80, days: 20, low: false } })
    expect(plenty).toContain('data-testid="sidebar-account-plan"')
    expect(plenty).toContain('<span>按量付费</span>')
    expect(plenty).toContain('style="width:67%"')
    expect(plenty).toContain('data-testid="sidebar-account-days">按最近用量，约还能用 20 天</span>')
    expect(plenty).not.toContain('is-low')
    const low = renderShell({ account: { signedIn: true, displayName: '星芒用户', balance: '$3.00', runway: { usableUsd: 3, days: 2, low: true } } })
    expect(low).toContain('v2-account-entry is-low')
    expect(low).toContain('余额不多了，约还能用 2 天')
    // 算不出天数（订阅不限额、最近没用量）就不画进度条和那行小字。
    const unknown = renderAccount({ signedIn: true, displayName: '星芒用户', balance: '$3.00', runway: { usableUsd: 3, days: null, low: true } })
    expect(unknown).not.toContain('v2-account-meter')
    expect(unknown).not.toContain('sidebar-account-days')
  })

  it('names the historical account in the card label', () => {
    expect(renderAccount({ signedIn: true, displayName: '星芒用户', sourceTag: '历史账号', balance: '$1.00' })).toContain('aria-label="个人中心：星芒用户（历史账号），余额 $1.00"')
    expect(renderAccount({ signedIn: true, displayName: '星芒用户' })).toContain('aria-label="个人中心：星芒用户"')
    expect(renderAccount({ signedIn: false })).toContain('aria-label="登录"')
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
    expect(markup).toContain('登录后自动配密钥')
  })
})

describe('renderer-v2 sidebar pinned navigation', () => {
  // 「更多」里的几页在 v4 各有了去处，「更多」去掉了（第 10 批）；钉在下面的只剩「设置」。
  it('pins only Settings outside the scrolling list, with no 更多 left', () => {
    const markup = render()
    const scroll = markup.slice(markup.indexOf('data-testid="sidebar-scroll"'), markup.indexOf('data-testid="sidebar-pinned"'))
    const pinned = markup.slice(markup.indexOf('data-testid="sidebar-pinned"'), markup.indexOf('data-testid="account-entry"'))
    expect(scroll).not.toContain('nav-settings')
    expect([...pinned.matchAll(/data-testid="nav-([a-z]+)"/g)].map((match) => match[1])).toEqual(['settings'])
    expect(markup).not.toContain('nav-more')
    expect(markup).not.toContain('更多')
  })

  it('names the search by what it does and shows the shortcut of this computer', () => {
    expect(render()).toContain('<span>搜索或跳转</span><kbd>Ctrl K</kbd>')
    expect(renderToStaticMarkup(createElement(Shell, { activePage: 'home', platform: 'mac', account: { signedIn: false }, adapter: {}, children: null }))).toContain('<kbd>⌘ K</kbd>')
  })
})

function renderShell(props: Partial<Parameters<typeof Shell>[0]> = {}): string {
  return renderToStaticMarkup(createElement(Shell, { activePage: 'home', platform: 'win', account: { signedIn: true, displayName: '星芒用户' }, adapter: {}, children: null, ...props }))
}

describe('renderer-v2 v4 sidebar', () => {
  it('lists the pages in v4 order, with the 扩展 group named and the last group set off by a line', () => {
    const markup = renderShell()
    const scroll = markup.slice(markup.indexOf('data-testid="sidebar-scroll"'), markup.indexOf('data-testid="sidebar-pinned"'))
    const order = [...scroll.matchAll(/data-testid="nav-([a-z]+)"/g)].map((match) => match[1])
    expect(order).toEqual(['home', 'chat', 'sessions', 'canvas', 'featured', 'mcp', 'skills', 'plugins', 'recharge', 'tutorial', 'health', 'feedback'])
    expect(scroll).toContain('role="group" aria-label="扩展"><p class="v2-nav-group-label" aria-hidden="true">扩展</p>')
    expect(scroll).toContain('<hr class="v2-nav-separator" aria-hidden="true"/>')
    expect(scroll).toContain('<span>反馈与客服</span>')
    expect(scroll).toContain('<span>画布</span><svg')
    expect(scroll).not.toContain('↗')
  })

  it('leaves 充值 out for an account that cannot top up in the app', () => {
    expect(renderShell({ account: { signedIn: true, displayName: '星芒用户', supportsBilling: false } })).not.toContain('data-testid="nav-recharge"')
  })

  it('tags 充值 with 余额低 when the runway is short, and lights it while the top-up tab is open', () => {
    const low = renderShell({ account: { signedIn: true, displayName: '星芒用户', runway: { usableUsd: 3, days: 2, low: true } } })
    expect(low).toContain('aria-label="充值，余额低"')
    expect(low).toContain('data-testid="nav-recharge-low">余额低</small>')
    const recharge = renderShell({ activePage: 'account', accountTab: 'recharge' })
    expect(recharge).toMatch(/class="v2-nav-item is-active"[^>]*data-testid="nav-recharge"/)
    expect(recharge).not.toContain('v2-account-entry is-active')
    expect(renderShell({ activePage: 'account', accountTab: 'overview' })).toContain('v2-account-entry is-active')
  })

  it('counts the environment issues on 检查', () => {
    const markup = renderShell({ environment: { tone: 'warn', label: '2 项需要处理', issues: 2 } })
    expect(markup).toContain('aria-label="检查，2 项需要处理"')
    expect(markup).toContain('data-testid="nav-health-issues">2</small>')
    expect(renderShell({ environment: { tone: 'ok', label: '环境正常', issues: 0 } })).not.toContain('nav-health-issues')
  })

  // 「安装卸载」页拆到首页和检查页（第 10 批），侧栏里没有它了。
  it('lists no 安装卸载 entry anywhere in the sidebar', () => {
    expect(renderShell()).not.toContain('data-testid="nav-maintenance"')
    expect(renderShell()).not.toContain('安装卸载')
  })
})

describe('renderer-v2 v4 top bar', () => {
  it('says where you are: the page, or 个人中心 and its tab', () => {
    expect(renderShell()).toContain('data-testid="window-titlebar"><strong>首页</strong></div>')
    expect(renderShell({ activePage: 'account', accountTab: 'recharge' })).toContain('data-testid="window-titlebar">个人中心<span aria-hidden="true">/</span><strong>充值订阅</strong></div>')
  })

  it('shows the theme key only when it can switch, and the other theme’s icon', () => {
    expect(renderShell()).not.toContain('shell-theme-toggle')
    const dark = renderShell({ theme: 'dark', adapter: { toggleTheme: () => undefined } })
    expect(dark).toContain('aria-label="切换深浅色"')
    expect(dark).toContain('lucide-sun')
    expect(renderShell({ theme: 'light', adapter: { toggleTheme: () => undefined } })).toContain('lucide-moon')
  })

  it('keeps announcements and help as icon buttons, and tells whether the announcement box is open', () => {
    const markup = renderShell({ unread: true, announcementOpen: true })
    expect(markup).toMatch(/aria-label="公告"[^>]*aria-expanded="true"[^>]*data-testid="announcement-open"/)
    expect(markup).toContain('<span class="v2-unread"></span>')
    expect(markup).toContain('aria-label="帮助与客服"')
    expect(markup).not.toContain('>帮助与客服</')
    expect(renderShell({ account: { signedIn: true, displayName: '星芒用户', supportsAnnouncements: false } })).not.toContain('announcement-open')
  })
})

describe('renderer-v2 v4 status bar', () => {
  function bar(props: Partial<Parameters<typeof Shell>[0]> = {}) {
    const markup = renderShell(props)
    return markup.slice(markup.indexOf('data-testid="shell-statusbar"'))
  }

  it('lists the environment, Node.js, the tools installed and the version with its update state', () => {
    const markup = bar({ environment: { tone: 'ok', label: '环境正常', issues: 0, node: 'Node.js 24.11.0' }, installedCount: 3, version: '0.2.19', update: 'available' })
    expect(markup).toContain('data-testid="statusbar-node">Node.js 24.11.0</span>')
    expect(markup).toContain('data-testid="statusbar-tools">已装 3 个工具</button>')
    expect(markup).toContain('data-testid="statusbar-version">v0.2.19 · 有新版本</button>')
    expect(bar({ version: '0.2.19', update: 'ready' })).toContain('v0.2.19 · 重启后更新')
    expect(bar({ version: '0.2.19' })).toContain('>v0.2.19</button>')
  })

  it('says 网络正常 with the country, and the line while game acceleration runs', () => {
    expect(bar({ network: { region: 'outside-mainland-china', countryCode: 'jp', publicIp: '203.0.113.9', checkedAt: '2026-10-15T00:00:00.000Z', error: null } })).toContain('网络正常 · 日本')
    expect(bar({ accelerationLine: '东京 2' })).toContain('加速中 · 东京 2')
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
    expect(linux).toContain('data-testid="nav-health"')
    expect(linux).toContain('data-testid="nav-home"')
    expect(linux).toContain('data-testid="nav-tutorial"')
  })

  it('keeps every page when nothing says otherwise', () => {
    const markup = renderShell()
    for (const id of ['home', 'chat', 'sessions', 'canvas', 'featured', 'mcp', 'skills', 'plugins', 'recharge', 'tutorial', 'health', 'feedback', 'settings']) expect(markup).toContain(`data-testid="nav-${id}"`)
  })

  // 游戏加速、备份、更新并进了设置（v4 批09），安装卸载拆到首页和检查页（第 10 批）。
  it('leaves the pages that moved elsewhere out of the sidebar', () => {
    const markup = renderShell()
    for (const id of ['acceleration', 'backups', 'updates', 'maintenance']) expect(markup).not.toContain(`data-testid="nav-${id}"`)
  })

  // #1104 第 12 条：第二步讲的是首页的工具卡片，开在别的页上就先不放。
  it('shows the interface tour only on the home page', () => {
    expect(renderShell({ tourOpen: true })).toContain('data-testid="shell-guide-tip"')
    for (const activePage of ['chat', 'account', 'settings'] as const) expect(renderShell({ tourOpen: true, activePage })).not.toContain('data-testid="shell-guide-tip"')
  })
})
