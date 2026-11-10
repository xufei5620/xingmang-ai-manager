import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CodexRemoteChannelSnapshot } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import {
  WeixinLoginDialogBody,
  WeixinRemoteSection,
  mergeWeixinLoginView,
  weixinLoginFinished,
  weixinLoginHeadline,
  weixinLoginKeepsPolling,
} from './WeixinRemoteSection'

function channel(overrides: Partial<CodexRemoteChannelSnapshot> = {}): CodexRemoteChannelSnapshot {
  return {
    channel: 'weixin',
    hasCredential: false,
    accountLabel: null,
    enabled: false,
    status: { state: 'stopped' },
    boundPeer: null,
    pairing: null,
    ...overrides,
  }
}

function noop(): void {
  return undefined
}

async function run(): Promise<boolean> {
  return true
}

describe('weixin login view helpers', () => {
  it('keeps the last QR image until a new one arrives', () => {
    const first = { loginId: 'a', phase: 'waiting-scan' as const, qrImage: 'data:image/png;base64,AAA', expiresAt: 10, retryAfterMs: 0 }
    expect(mergeWeixinLoginView(first, { loginId: 'a', phase: 'scanned', retryAfterMs: 0 })).toMatchObject({ phase: 'scanned', qrImage: 'data:image/png;base64,AAA', expiresAt: 10 })
    expect(mergeWeixinLoginView(first, { loginId: 'a', phase: 'waiting-scan', qrImage: 'data:image/png;base64,BBB', retryAfterMs: 0 }).qrImage).toBe('data:image/png;base64,BBB')
    expect(mergeWeixinLoginView(first, { loginId: 'b', phase: 'scanned', retryAfterMs: 0 }).qrImage).toBeUndefined()
  })

  it('polls while waiting on the phone and stops to wait for typed digits', () => {
    expect(weixinLoginKeepsPolling('waiting-scan')).toBe(true)
    expect(weixinLoginKeepsPolling('scanned')).toBe(true)
    expect(weixinLoginKeepsPolling('need-verify-code')).toBe(false)
    expect(weixinLoginKeepsPolling('verify-code-wrong')).toBe(false)
    expect(weixinLoginFinished('confirmed')).toBe(true)
    expect(weixinLoginFinished('scanned')).toBe(false)
  })

  it('says what to do next in each phase', () => {
    expect(weixinLoginHeadline('scanned', false)).toBe('已扫码，请在手机上点确认')
    expect(weixinLoginHeadline('verify-code-wrong', false)).toBe('数字不对，请对照手机上的数字重新输入')
    expect(weixinLoginHeadline('failed', false)).toBeNull()
  })

  it('points a first login at the switch before pairing, and tells a rescan that kept its person not to pair again', () => {
    expect(weixinLoginHeadline('confirmed', false)).toBe('微信登录好了。下一步打开下面的「打开遥控」，再点「开始配对」，在微信的 ClawBot 对话里发配对码。')
    expect(weixinLoginHeadline('confirmed', true)).toBe('微信登录好了，绑定的人没变，不用重新配对。')
    // 还在扫码时绑没绑人都一样。
    expect(weixinLoginHeadline('scanned', true)).toBe('已扫码，请在手机上点确认')
  })
})

describe('WeixinRemoteSection', () => {
  it('warns that the channel is experimental and offers a scan before login', () => {
    const markup = renderToStaticMarkup(<WeixinRemoteSection snapshot={channel()} api={{} as V2Bridge} disabled={false} busy="" run={run} />)
    expect(markup).toContain('实验功能，随时可能断')
    expect(markup).toContain('腾讯随时可能限流或关掉它')
    expect(markup).toMatch(/data-testid="settings-remote-weixin-login-start"[^>]*><span>扫码登录<\/span>/)
    expect(markup).not.toContain('settings-remote-weixin-dialog')
  })

  it('shows which ClawBot is linked and offers a rescan', () => {
    const markup = renderToStaticMarkup(<WeixinRemoteSection snapshot={channel({ hasCredential: true, accountLabel: 'ClawBot 1a2b' })} api={{} as V2Bridge} disabled={false} busy="" run={run} />)
    expect(markup).toContain('已登录：ClawBot 1a2b')
    expect(markup).toMatch(/data-testid="settings-remote-weixin-login-start"[^>]*><span>重新扫码<\/span>/)
  })

  it('disables the scan while the card says remote control is unavailable', () => {
    const markup = renderToStaticMarkup(<WeixinRemoteSection snapshot={channel()} api={{} as V2Bridge} disabled busy="" run={run} />)
    expect(markup).toMatch(/data-testid="settings-remote-weixin-login-start" disabled=""/)
  })

  it('spins the scan button while the card is fetching the QR code', () => {
    const markup = renderToStaticMarkup(<WeixinRemoteSection snapshot={channel()} api={{} as V2Bridge} disabled busy="weixin-login" run={run} />)
    expect(markup).toMatch(/data-testid="settings-remote-weixin-login-start"[^>]*aria-busy="true"/)
  })
})

describe('WeixinLoginDialogBody', () => {
  it('shows the QR image drawn by the main process while waiting', () => {
    const markup = renderToStaticMarkup(<WeixinLoginDialogBody hasBoundPeer={false} view={{ loginId: 'a', phase: 'waiting-scan', qrImage: 'data:image/png;base64,AAA', retryAfterMs: 0 }} code="" onCodeChange={noop} onSubmitCode={noop} busy={false} />)
    expect(markup).toContain('src="data:image/png;base64,AAA"')
    expect(markup).toContain('alt="微信登录二维码"')
    expect(markup).toContain('二维码 5 分钟内有效')
    expect(markup).not.toContain('settings-remote-weixin-code')
  })

  it('asks for the digits shown on the phone without the QR code', () => {
    const markup = renderToStaticMarkup(<WeixinLoginDialogBody hasBoundPeer={false} view={{ loginId: 'a', phase: 'need-verify-code', qrImage: 'data:image/png;base64,AAA', retryAfterMs: 0 }} code="" onCodeChange={noop} onSubmitCode={noop} busy={false} />)
    expect(markup).toContain('手机微信上显示了一串数字，请输在下面')
    expect(markup).toContain('data-testid="settings-remote-weixin-code"')
    expect(markup).toContain('inputMode="numeric"')
    expect(markup).not.toContain('data:image/png')
  })

  it('uses the card snapshot to word the login that just finished', () => {
    const view = { loginId: 'a', phase: 'confirmed' as const, retryAfterMs: 0 }
    expect(renderToStaticMarkup(<WeixinLoginDialogBody hasBoundPeer={false} view={view} code="" onCodeChange={noop} onSubmitCode={noop} busy={false} />)).toContain('<p>微信登录好了。下一步打开下面的「打开遥控」，再点「开始配对」，在微信的 ClawBot 对话里发配对码。</p>')
    expect(renderToStaticMarkup(<WeixinLoginDialogBody hasBoundPeer view={view} code="" onCodeChange={noop} onSubmitCode={noop} busy={false} />)).toContain('<p>微信登录好了，绑定的人没变，不用重新配对。</p>')
  })

  it('shows the main-process failure message as an alert', () => {
    const markup = renderToStaticMarkup(<WeixinLoginDialogBody hasBoundPeer={false} view={{ loginId: 'a', phase: 'failed', message: '二维码过期太多次，请重新开始', retryAfterMs: 0 }} code="" onCodeChange={noop} onSubmitCode={noop} busy={false} />)
    expect(markup).toMatch(/role="alert"[^>]*>二维码过期太多次，请重新开始/)
  })
})
