import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OfflineBanner } from './OfflineBanner'
import { Shell } from './Shell'
import { OnlineStatusContext, type OnlineStatus } from './useOnlineStatus'

function withStatus(status: Partial<OnlineStatus>, child: ReactElement): string {
  return renderToStaticMarkup(createElement(OnlineStatusContext.Provider, { value: { offline: false, checking: false, recheck() {}, ...status } }, child))
}

function shellProps() {
  return {
    activePage: 'home' as const,
    platform: 'win' as const,
    account: { signedIn: true, displayName: '星芒用户', balance: '$3.00', balanceError: '余额暂时没有读到，请检查网络后重试。' },
    adapter: {},
    children: null,
  }
}

describe('renderer-v2 offline banner', () => {
  it('stays out of the page while the network works', () => {
    expect(renderToStaticMarkup(createElement(OfflineBanner))).toBe('')
    expect(withStatus({ offline: false }, createElement(OfflineBanner))).toBe('')
  })

  it('explains what still works and offers a recheck when offline', () => {
    const markup = withStatus({ offline: true }, createElement(OfflineBanner))
    expect(markup).toContain('data-testid="offline-banner"')
    expect(markup).toContain('现在连不上网。已经装好的 AI 工具照常能用；充值、聊天、安装和更新要等网络恢复。')
    expect(markup).toContain('data-testid="offline-banner-recheck"')
    expect(markup).toContain('重新检测')
  })

  it('sits at the top of the shell and relabels the balance failure', () => {
    const offline = withStatus({ offline: true }, createElement(Shell, shellProps()))
    expect(offline).toContain('data-testid="offline-banner"')
    expect(offline.indexOf('offline-banner')).toBeLessThan(offline.indexOf('page-viewport'))
    expect(offline).toContain('没网，稍后自动刷新')
    expect(offline).not.toContain('>更新失败<')
    const online = withStatus({ offline: false }, createElement(Shell, shellProps()))
    expect(online).not.toContain('offline-banner')
    expect(online).toContain('>更新失败<')
  })
})
