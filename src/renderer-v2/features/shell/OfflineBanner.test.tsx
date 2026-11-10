import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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

  it('says the AI tools wait for the network too and offers a recheck when offline', () => {
    const markup = withStatus({ offline: true }, createElement(OfflineBanner))
    expect(markup).toContain('data-testid="offline-banner"')
    // 中转和账号是同一个站点：本机连不上网时 Claude Code、Codex 一样连不上，不能叫客户照常去用。
    expect(markup).toContain('现在连不上网。AI 工具、聊天、充值、安装和更新都要等网络恢复；装好的工具和设置都还在，不用重装。')
    expect(markup).not.toContain('照常能用')
    expect(markup).toContain('data-testid="offline-banner-recheck"')
    expect(markup).toContain('>重试<')
    expect(markup).not.toContain('重新检测')
  })

  it('points a broken proxy at the system proxy settings', () => {
    const openNetworkSettings = vi.fn()
    const markup = withStatus({ offline: true, cause: 'proxy', openNetworkSettings }, createElement(OfflineBanner))
    expect(markup).toContain('data-cause="proxy"')
    expect(markup).toContain('电脑里设置的代理连不上，所以现在上不了网。请重新打开你的代理软件，或者把系统代理关掉。')
    // 「加速」是星芒已经下线的功能名，客户会以为是让他打开星芒自己的加速。
    expect(markup).not.toContain('加速')
    expect(markup).toContain('data-testid="offline-banner-proxy-settings"')
    expect(markup).toContain('打开系统代理设置')
    expect(markup).toContain('data-testid="offline-banner-recheck"')
    expect(markup).not.toContain('打开认证页')
  })

  it('offers the sign-in page when the network wants a portal login first', () => {
    const markup = withStatus({ offline: true, cause: 'portal', openNetworkSettings() {} }, createElement(OfflineBanner))
    expect(markup).toContain('这个网络要先登录认证（校园网、酒店、公共 Wi-Fi 常见）。')
    expect(markup).toContain('data-testid="offline-banner-portal"')
    expect(markup).toContain('打开认证页')
    expect(markup).not.toContain('打开系统代理设置')
  })

  it('explains the automatic direct connection once the broken proxy was bypassed', () => {
    const markup = withStatus({ offline: false, proxyBypassNotice: true, openNetworkSettings() {}, dismissProxyBypassNotice() {} }, createElement(OfflineBanner))
    expect(markup).toContain('data-testid="proxy-bypass-banner"')
    expect(markup).toContain('电脑里设置的代理连不上，星芒已经改为直接联网，可以照常使用。浏览器等其他软件可能还上不了网，可以点右边去关掉代理。')
    expect(markup).toContain('打开系统代理设置')
    expect(markup).toContain('data-testid="proxy-bypass-banner-dismiss"')
    expect(markup).toContain('知道了')
    expect(markup).not.toContain('>重试<')
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
