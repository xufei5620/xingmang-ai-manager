import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AA==') } }))

import QRCode from 'qrcode'
import { classifyNetworkFailure } from './network-failure'
import type { NewApiPaymentForm, NewApiTopupOrderStatus } from './new-api-client'
import { RealmAccountError } from './realm-account'
import {
  PaymentCheckoutRejected,
  buildPaymentWindowSize,
  buildPaymentWindowTitle,
  createPaymentWindowController,
  detectPaymentWindowTerminalStatus,
  isAllowedPaymentNavigationUrl,
  isPaymentWindowReady,
  paymentFollowUpDelayMs,
  paymentFollowUpMaxMs,
  paymentFormLimits,
  paymentPageOpenTimeoutMs,
  paymentWindowMinimumSize,
  paymentWindowPreferredSize,
  paymentWindowShowFallbackMs,
  resolvePaymentAppLaunchScheme,
  validatePaymentForm,
  validatePaymentUrl,
  waitForPaymentPage,
  type PaymentWindowControllerOptions,
} from './payment-window'

function paymentForm(overrides: Partial<NewApiPaymentForm> = {}): NewApiPaymentForm {
  return {
    action: 'https://pay.example.com/submit?channel=alipay',
    allowedOrigin: 'https://pay.example.com',
    method: 'POST',
    fields: [
      { name: 'out_trade_no', value: 'XM-20260815-1' },
      { name: 'subject', value: '星芒 AI & 会员 <充值>' },
      { name: 'empty', value: '' },
    ],
    tradeNo: 'XM-20260815-1',
    ...overrides,
  }
}

// 乐风码付收银台画完二维码后跳的那种地址（#1458），付款码那串换成了假的。
const alipayAppLaunchUrl = 'alipays://platformapi/startapp?saId=10000007&clientVersion=3.7.0.0718&qrcode=https%3A%2F%2Fqr.alipay.com%2Ffake'
const weixinAppLaunchUrl = 'weixin://wxpay/bizpayurl?pr=fake'

function createHarness(loadError?: Error, terminalSnapshot = '', options: Pick<PaymentWindowControllerOptions, 'createOrderStatusReader' | 'iconPath' | 'resolveWorkArea'> = {}) {
  const windowEvents = new Map<string, (...args: any[]) => void>()
  const webContentsEvents = new Map<string, (...args: any[]) => void>()
  const sessionEvents = new Map<string, (...args: any[]) => void>()
  let destroyed = false
  let minimized = false
  const session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => sessionEvents.set(name, handler)),
  }
  const webContents = {
    session,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => webContentsEvents.set(name, handler)),
    executeJavaScript: vi.fn(async () => terminalSnapshot),
  }
  const window = {
    webContents,
    once: vi.fn((name: string, handler: (...args: any[]) => void) => windowEvents.set(name, handler)),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => windowEvents.set(name, handler)),
    loadURL: vi.fn(async (_url: string, _options?: {
      extraHeaders?: string
      postData?: Array<{ bytes: Buffer }>
    }) => {
      if (loadError) throw loadError
      windowEvents.get('ready-to-show')?.()
    }),
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => minimized),
    center: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => {
      destroyed = true
      windowEvents.get('closed')?.()
    }),
    destroy: vi.fn(() => {
      destroyed = true
      windowEvents.get('closed')?.()
    }),
    setTitle: vi.fn(),
    setMinimumSize: vi.fn(),
    setSize: vi.fn(),
  }
  const createWindow = vi.fn(() => window as never)
  const onBlockedNavigation = vi.fn()
  const onTerminalState = vi.fn()
  const controller = createPaymentWindowController({ createWindow, onBlockedNavigation, onTerminalState, ...options })
  return {
    controller,
    createWindow,
    onBlockedNavigation,
    onTerminalState,
    session,
    sessionEvents,
    webContents,
    webContentsEvents,
    window,
    windowEvents,
  }
}

const inWindow = { afterClose: false }
const afterClose = { afterClose: true }

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('validatePaymentForm', () => {
  it('builds an encoded POST body and an exact-origin allowlist', () => {
    const result = validatePaymentForm(paymentForm())

    expect(result.action).toBe('https://pay.example.com/submit?channel=alipay')
    expect(result.encodedBody).toBe(
      'out_trade_no=XM-20260815-1&subject=%E6%98%9F%E8%8A%92+AI+%26+%E4%BC%9A%E5%91%98+%3C%E5%85%85%E5%80%BC%3E&empty=',
    )
    expect([...result.allowedOrigins]).toEqual([
      'https://xm.solov.cc',
      'https://pay.example.com',
    ])
  })

  it.each([
    ['plain HTTP', { action: 'http://pay.example.com/submit', allowedOrigin: 'http://pay.example.com' }],
    ['URL credentials', { action: 'https://user:pass@pay.example.com/submit' }],
    ['URL fragment', { action: 'https://pay.example.com/submit#callback' }],
    ['non-POST method', { method: 'GET' as never }],
    ['origin mismatch', { allowedOrigin: 'https://attacker.example' }],
    ['origin with a path', { allowedOrigin: 'https://pay.example.com/not-an-origin' }],
  ])('rejects %s', (_name, overrides) => {
    // 归成校验没过这一类，下单那两个 IPC 才认得出、换成给客户看的那句（#1100 第5条）。
    expect(() => validatePaymentForm(paymentForm(overrides))).toThrow(PaymentCheckoutRejected)
  })

  it('enforces field count, names, individual values, total payload and trade number limits', () => {
    expect(() => validatePaymentForm(paymentForm({ fields: [] }))).toThrow('字段数量')
    expect(() => validatePaymentForm(paymentForm({
      fields: Array.from({ length: paymentFormLimits.fieldCount + 1 }, (_, index) => ({
        name: `field${index}`,
        value: 'x',
      })),
    }))).toThrow('字段数量')
    expect(() => validatePaymentForm(paymentForm({
      fields: [{ name: 'bad[name]', value: 'x' }],
    }))).toThrow('字段名称')
    expect(() => validatePaymentForm(paymentForm({
      fields: [{ name: 'value', value: 'x'.repeat(paymentFormLimits.fieldValueLength + 1) }],
    }))).toThrow('字段内容')
    expect(() => validatePaymentForm(paymentForm({
      fields: Array.from({ length: 17 }, (_, index) => ({
        name: `field${index}`,
        value: 'x'.repeat(paymentFormLimits.fieldValueLength),
      })),
    }))).toThrow('安全上限')
    expect(() => validatePaymentForm(paymentForm({
      fields: Array.from({ length: 15 }, (_, index) => ({
        name: `field${index}`,
        value: '<'.repeat(paymentFormLimits.fieldValueLength),
      })),
    }))).toThrow('编码后内容超过安全上限')
    expect(() => validatePaymentForm(paymentForm({
      tradeNo: 'x'.repeat(paymentFormLimits.tradeNoLength + 1),
    }))).toThrow('订单号')
  })
})

describe('validatePaymentUrl', () => {
  it('accepts credential-free HTTPS checkout URLs and keeps an exact-origin allowlist', () => {
    const result = validatePaymentUrl('https://checkout.example.com/session#token=opaque')
    expect(result.url).toBe('https://checkout.example.com/session#token=opaque')
    expect([...result.allowedOrigins]).toEqual(['https://xm.solov.cc', 'https://checkout.example.com'])
  })

  it.each([
    'http://checkout.example.com/session',
    'https://user:pass@checkout.example.com/session',
    'javascript:alert(1)',
  ])('rejects an unsafe checkout URL: %s', (url) => {
    expect(() => validatePaymentUrl(url)).toThrow('支付地址')
    expect(() => validatePaymentUrl(url)).toThrow(PaymentCheckoutRejected)
  })
})

describe('payment navigation policy', () => {
  const origins = new Set(['https://xm.solov.cc', 'https://pay.example.com'])

  it('allows only credential-free HTTPS URLs on exact origins', () => {
    expect(isAllowedPaymentNavigationUrl('https://xm.solov.cc/console/topup', origins)).toBe(true)
    expect(isAllowedPaymentNavigationUrl('https://pay.example.com/result?id=1', origins)).toBe(true)
    expect(isAllowedPaymentNavigationUrl('https://user@pay.example.com/result', origins)).toBe(false)
    expect(isAllowedPaymentNavigationUrl('http://pay.example.com/result', origins)).toBe(false)
    expect(isAllowedPaymentNavigationUrl('https://pay.example.com.evil.test/', origins)).toBe(false)
    expect(isAllowedPaymentNavigationUrl('javascript:alert(1)', origins)).toBe(false)
  })

  it('never lets the Alipay or WeChat app-launch links through', () => {
    expect(isAllowedPaymentNavigationUrl(alipayAppLaunchUrl, origins)).toBe(false)
    expect(isAllowedPaymentNavigationUrl(weixinAppLaunchUrl, origins)).toBe(false)
  })

  it('names only the scheme of an Alipay or WeChat app-launch link', () => {
    expect(resolvePaymentAppLaunchScheme(alipayAppLaunchUrl)).toBe('alipays')
    expect(resolvePaymentAppLaunchScheme('alipay://platformapi/startapp?saId=10000007')).toBe('alipay')
    expect(resolvePaymentAppLaunchScheme(weixinAppLaunchUrl)).toBe('weixin')
    expect(resolvePaymentAppLaunchScheme('ALIPAYS://platformapi/startapp')).toBe('alipays')
  })

  it('treats every other blocked address as an unexpected navigation', () => {
    expect(resolvePaymentAppLaunchScheme('https://attacker.example/')).toBeNull()
    expect(resolvePaymentAppLaunchScheme('https://qr.alipay.com/abc')).toBeNull()
    expect(resolvePaymentAppLaunchScheme('alipays.evil.test://x')).toBeNull()
    expect(resolvePaymentAppLaunchScheme('javascript:alert(1)')).toBeNull()
    expect(resolvePaymentAppLaunchScheme('file:///C:/Windows/System32/calc.exe')).toBeNull()
    expect(resolvePaymentAppLaunchScheme('not a url')).toBeNull()
  })
})

describe('payment window title', () => {
  // #1069 第4条：付款地址是后端给的，标题带上实际所在的域名，客户才看得出在哪个网站上付钱。
  it('names the host of a third-party payment page, port included', () => {
    expect(buildPaymentWindowTitle('https://pay.example.com/submit?channel=alipay&sign=private'))
      .toBe('安全支付 - 星芒AI（当前网页：pay.example.com）')
    expect(buildPaymentWindowTitle('https://pay.example.com:8443/submit'))
      .toBe('安全支付 - 星芒AI（当前网页：pay.example.com:8443）')
  })

  it('shows look-alike international domains in their punycode form', () => {
    expect(buildPaymentWindowTitle('https://例子.测试/pay'))
      .toBe('安全支付 - 星芒AI（当前网页：xn--fsqu00a.xn--0zwm56d）')
  })

  it('keeps the plain title for our own sites, the drawn QR page and unparsable addresses', () => {
    for (const url of [
      'https://xm.solov.cc/console/topup',
      'https://api.solov.cc/payment/return',
      'data:text/html;charset=utf-8,%3Ctitle%3E',
      'not a url',
    ]) expect(buildPaymentWindowTitle(url)).toBe('安全支付 - 星芒AI')
  })
})

describe('payment window size', () => {
  const regular = {
    width: paymentWindowPreferredSize.width,
    height: paymentWindowPreferredSize.height,
    minWidth: paymentWindowMinimumSize.width,
    minHeight: paymentWindowMinimumSize.height,
  }

  it('keeps the regular size on a screen with room for it, and when the screen is unknown', () => {
    expect(buildPaymentWindowSize({ width: 1920, height: 1040 })).toEqual(regular)
    expect(buildPaymentWindowSize({ width: 1440, height: 875 })).toEqual(regular)
    expect(buildPaymentWindowSize(null)).toEqual(regular)
    expect(buildPaymentWindowSize(undefined)).toEqual(regular)
    expect(buildPaymentWindowSize({ width: Number.NaN, height: 700 })).toEqual(regular)
    expect(buildPaymentWindowSize({ width: 0, height: 0 })).toEqual(regular)
  })

  it('shrinks to the usable height of a small laptop screen, leaving a margin', () => {
    // 1366×768 with the taskbar; 1920×1080 at 150% scaling with the taskbar.
    expect(buildPaymentWindowSize({ width: 1366, height: 728 })).toEqual({ ...regular, height: 696 })
    expect(buildPaymentWindowSize({ width: 1280, height: 680 })).toEqual({ ...regular, height: 648 })
  })

  it('lowers the minimum size along with the window so it cannot be pushed back off screen', () => {
    // 1280×720 at 125% scaling with the taskbar.
    expect(buildPaymentWindowSize({ width: 1024, height: 548 })).toEqual({ ...regular, height: 516, minHeight: 516 })
    expect(buildPaymentWindowSize({ width: 600, height: 548 })).toEqual({ width: 568, height: 516, minWidth: 560, minHeight: 516 })
    expect(buildPaymentWindowSize({ width: 540.5, height: 548 })).toEqual({ width: 508, height: 516, minWidth: 508, minHeight: 516 })
  })

  it('never turns a tiny screen into a negative size', () => {
    expect(buildPaymentWindowSize({ width: 40, height: 30 })).toEqual({ width: 40, height: 30, minWidth: 40, minHeight: 30 })
  })
})

describe('payment terminal-state detection', () => {
  it.each([
    ['订单已超时', 'expired'],
    ['二维码过期\n请重新下单', 'expired'],
    ['交易已关闭', 'expired'],
    ['支付失败', 'failed'],
  ] as const)('maps %s to %s', (snapshot, status) => {
    expect(detectPaymentWindowTerminalStatus(snapshot)).toBe(status)
  })

  it('does not treat countdown guidance as a terminal state', () => {
    expect(detectPaymentWindowTerminalStatus('请在 5 分钟内支付，超时后订单将关闭')).toBeNull()
    expect(detectPaymentWindowTerminalStatus([
      '支付剩余时间',
      '04:59',
      '超时订单将自动关闭',
      '支付超时后，请重新创建订单',
    ].join('\n'))).toBeNull()
    expect(detectPaymentWindowTerminalStatus(null)).toBeNull()
  })

  it('treats a real zero countdown as expired even when the page only shows guidance', () => {
    expect(detectPaymentWindowTerminalStatus([
      '支付剩余时间',
      '00:00',
      '支付超时后，请重新创建订单',
    ].join('\n'))).toBe('expired')
  })

  it('arms terminal detection only after a real countdown replaces the loading placeholder', () => {
    expect(isPaymentWindowReady('支付剩余时间 Na:Na')).toBe(false)
    expect(isPaymentWindowReady('支付剩余时间 04:59')).toBe(true)
    expect(isPaymentWindowReady('剩余 4 分 59 秒')).toBe(true)
  })
})

describe('createPaymentWindowController', () => {
  it('opens a validated GET checkout URL without a POST body', async () => {
    const harness = createHarness()
    await harness.controller.openUrl('https://checkout.example.com/session#token=opaque')

    expect(harness.window.loadURL).toHaveBeenCalledWith(
      'https://checkout.example.com/session#token=opaque',
      undefined,
    )
    const navigationHandler = harness.webContentsEvents.get('will-navigate')!
    const allowedEvent = { preventDefault: vi.fn() }
    navigationHandler(allowedEvent, 'https://checkout.example.com/complete')
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('submits the form without generating executable HTML or JavaScript', async () => {
    const harness = createHarness(undefined, '', { iconPath: '/app/assets/brand/v3/app-icon.png' })
    const parent = {} as never

    await harness.controller.open(paymentForm(), parent)

    expect(harness.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      parent,
      show: false,
      title: '安全支付 - 星芒AI（当前网页：pay.example.com）',
      icon: '/app/assets/brand/v3/app-icon.png',
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      }),
    }))
    // Modal would disable the main window on Windows and turn the window into a
    // close-button-less sheet on macOS; the in-app close button must stay usable.
    expect(harness.createWindow).toHaveBeenCalledWith(expect.not.objectContaining({ modal: expect.anything() }))
    expect(harness.window.loadURL).toHaveBeenCalledOnce()
    const [target, options] = harness.window.loadURL.mock.calls[0]!
    if (!options?.postData) throw new Error('expected POST load options')
    expect(target).toBe('https://pay.example.com/submit?channel=alipay')
    expect(options.extraHeaders).toContain('application/x-www-form-urlencoded')
    expect(options.postData).toHaveLength(1)
    expect(options.postData[0].bytes.toString('utf8')).toContain('subject=%E6%98%9F%E8%8A%92')
    expect(harness.window.center).toHaveBeenCalledOnce()
    expect(harness.window.show).toHaveBeenCalledOnce()
    expect(harness.window.focus).toHaveBeenCalledOnce()
    const pageTitleEvent = { preventDefault: vi.fn() }
    harness.windowEvents.get('page-title-updated')?.(pageTitleEvent)
    expect(pageTitleEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.window.setTitle).toHaveBeenCalledWith('安全支付 - 星芒AI（当前网页：pay.example.com）')
    expect(harness.controller.isOpen()).toBe(true)
  })

  it('fits the window to the screen it lands on before showing it', async () => {
    const resolveWorkArea = vi.fn(() => ({ width: 1366, height: 728 }))
    const harness = createHarness(undefined, '', { resolveWorkArea })

    await harness.controller.openUrl('https://checkout.example.com/session')

    expect(resolveWorkArea).toHaveBeenCalledWith(harness.window)
    expect(harness.window.setMinimumSize).toHaveBeenCalledWith(560, 640)
    expect(harness.window.setSize).toHaveBeenCalledWith(760, 696)
    // Shrunk while still hidden, then centred and shown.
    expect(harness.window.setSize.mock.invocationCallOrder[0]).toBeLessThan(harness.window.show.mock.invocationCallOrder[0]!)
    expect(harness.window.center).toHaveBeenCalledOnce()
  })

  it('leaves the regular size alone on a large screen or without screen information', async () => {
    const large = createHarness(undefined, '', { resolveWorkArea: () => ({ width: 1920, height: 1040 }) })
    await large.controller.openUrl('https://checkout.example.com/session')
    expect(large.window.setSize).not.toHaveBeenCalled()
    expect(large.window.setMinimumSize).not.toHaveBeenCalled()

    const unknown = createHarness()
    await unknown.controller.openUrl('https://checkout.example.com/session')
    expect(unknown.createWindow).toHaveBeenCalledWith(expect.objectContaining({ width: 760, height: 820, minWidth: 560, minHeight: 640 }))
    expect(unknown.window.setSize).not.toHaveBeenCalled()
  })

  it('retitles the window with the committed host after every navigation and keeps page titles out', async () => {
    const harness = createHarness()
    await harness.controller.openUrl('https://checkout.example.com/session')
    expect(harness.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      title: '安全支付 - 星芒AI（当前网页：checkout.example.com）',
    }))
    const navigated = harness.webContentsEvents.get('did-navigate')!
    const pageTitleUpdated = harness.windowEvents.get('page-title-updated')!

    navigated({}, 'https://xm.solov.cc/console/topup')
    expect(harness.window.setTitle).toHaveBeenLastCalledWith('安全支付 - 星芒AI')
    pageTitleUpdated({ preventDefault: vi.fn() })
    expect(harness.window.setTitle).toHaveBeenLastCalledWith('安全支付 - 星芒AI')

    navigated({}, 'https://checkout.example.com/complete?id=1')
    expect(harness.window.setTitle).toHaveBeenLastCalledWith('安全支付 - 星芒AI（当前网页：checkout.example.com）')
    const pageTitleEvent = { preventDefault: vi.fn() }
    pageTitleUpdated(pageTitleEvent)
    expect(pageTitleEvent.preventDefault).toHaveBeenCalledOnce()
    expect(harness.window.setTitle).toHaveBeenLastCalledWith('安全支付 - 星芒AI（当前网页：checkout.example.com）')
  })

  it('keeps the drawn QR page title free of any host', async () => {
    const harness = createHarness()
    await harness.controller.openQrCode(qrPayment())
    expect(harness.createWindow).toHaveBeenCalledWith(expect.objectContaining({ title: '安全支付 - 星芒AI' }))
    harness.webContentsEvents.get('did-navigate')!({}, harness.window.loadURL.mock.calls[0]![0])
    harness.windowEvents.get('page-title-updated')!({ preventDefault: vi.fn() })
    expect(harness.window.setTitle.mock.calls.every(([title]) => title === '安全支付 - 星芒AI')).toBe(true)
  })

  it('closes the window and reports the matching trade number when the provider page expires', async () => {
    const harness = createHarness(undefined, '支付剩余时间\n00:00\n支付超时后，请重新创建订单')

    await harness.controller.open(paymentForm())
    await vi.waitFor(() => expect(harness.onTerminalState).toHaveBeenCalledWith({
      status: 'expired',
      tradeNo: 'XM-20260815-1',
    }, inWindow))
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.window.close).not.toHaveBeenCalled()
    expect(harness.window.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onTerminalState.mock.invocationCallOrder[0]!,
    )
    expect(harness.controller.isOpen()).toBe(false)
  })

  it('keeps a newly opened payment page alive while its countdown is still Na:Na', async () => {
    const harness = createHarness(undefined, 'Na:Na 支付超时')

    await harness.controller.open(paymentForm())
    await vi.waitFor(() => expect(harness.webContents.executeJavaScript).toHaveBeenCalled())
    expect(harness.onTerminalState).not.toHaveBeenCalled()
    expect(harness.window.destroy).not.toHaveBeenCalled()
    expect(harness.controller.isOpen()).toBe(true)
  })

  it('reports a user-closed payment window with its matching trade number', async () => {
    const harness = createHarness()

    await harness.controller.open(paymentForm())
    harness.window.close()

    expect(harness.onTerminalState).toHaveBeenCalledOnce()
    expect(harness.onTerminalState).toHaveBeenCalledWith({
      status: 'closed',
      tradeNo: 'XM-20260815-1',
    }, inWindow)
    expect(harness.controller.isOpen()).toBe(false)
  })

  it('denies permissions, device access, downloads and every popup', async () => {
    const harness = createHarness()
    await harness.controller.open(paymentForm())

    const callback = vi.fn()
    harness.session.setPermissionRequestHandler.mock.calls[0]?.[0]({}, 'notifications', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(harness.session.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false)
    expect(harness.session.setDevicePermissionHandler.mock.calls[0]?.[0]()).toBe(false)

    const downloadEvent = { preventDefault: vi.fn() }
    harness.sessionEvents.get('will-download')?.(downloadEvent)
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce()

    const popupHandler = harness.webContents.setWindowOpenHandler.mock.calls[0]?.[0]
    expect(popupHandler({ url: 'https://pay.example.com/next' })).toEqual({ action: 'deny' })
    expect(popupHandler({ url: 'https://attacker.example/' })).toEqual({ action: 'deny' })
    expect(harness.onBlockedNavigation).toHaveBeenCalledWith('https://attacker.example/')
  })

  it('blocks cross-origin navigation and redirects while allowing both exact origins', async () => {
    const harness = createHarness()
    await harness.controller.open(paymentForm())
    const navigationHandler = harness.webContentsEvents.get('will-navigate')!
    const redirectHandler = harness.webContentsEvents.get('will-redirect')!

    const allowedEvent = { preventDefault: vi.fn() }
    navigationHandler(allowedEvent, 'https://pay.example.com/result')
    navigationHandler(allowedEvent, 'https://xm.solov.cc/console/topup')
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()

    const blockedNavigation = { preventDefault: vi.fn() }
    navigationHandler(blockedNavigation, 'https://attacker.example/')
    expect(blockedNavigation.preventDefault).toHaveBeenCalledOnce()

    const blockedRedirect = { preventDefault: vi.fn() }
    redirectHandler(blockedRedirect, 'https://pay.example.com.evil.test/')
    expect(blockedRedirect.preventDefault).toHaveBeenCalledOnce()
    expect(harness.onBlockedNavigation).toHaveBeenCalledTimes(2)
  })

  it('closes for the in-app button and force destroys', async () => {
    const graceful = createHarness()
    await graceful.controller.open(paymentForm())
    graceful.controller.close()
    expect(graceful.window.destroy).toHaveBeenCalledOnce()
    expect(graceful.onTerminalState).not.toHaveBeenCalled()
    expect(graceful.controller.isOpen()).toBe(false)

    const forced = createHarness()
    await forced.controller.open(paymentForm())
    forced.controller.destroy()
    expect(forced.window.destroy).toHaveBeenCalledOnce()
    expect(forced.onTerminalState).not.toHaveBeenCalled()
    expect(forced.controller.isOpen()).toBe(false)
  })

  it('destroys a failed window and returns a stable user-facing error', async () => {
    const harness = createHarness(new Error('network down'))

    await expect(harness.controller.open(paymentForm())).rejects.toThrow(
      '支付页面打开失败，请稍后重试。这次没有扣款，「我的订单」里多出来的订单放着就行。',
    )
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.controller.isOpen()).toBe(false)
  })

  // The runtime log records the cause; the address carries the order number and the signature.
  it('keeps only the error code of a failed load as the cause, never the payment address', async () => {
    const address = 'https://pay.example.com/submit?channel=alipay&out_trade_no=XM-20260815-1&sign=private-signature'
    const harness = createHarness(Object.assign(new Error(`ERR_CONNECTION_RESET (-101) loading '${address}'`), {
      errno: -101,
      code: 'ERR_CONNECTION_RESET',
      url: address,
    }))

    const failure: unknown = await harness.controller.open(paymentForm()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error && failure.message).toBe('支付页面打开失败，请稍后重试。这次没有扣款，「我的订单」里多出来的订单放着就行。')
    expect(failure instanceof Error && failure.cause).toEqual({ code: 'ERR_CONNECTION_RESET' })
    // The failure log still tells a cut connection apart from a certificate or a lookup.
    expect(classifyNetworkFailure(failure)).toBe('refused')
  })
})

function qrPayment(tradeNo = 'sub2-qr-1') {
  return { code: 'https://qr.alipay.com/example', tradeNo, expiresAt: null, amount: 1, currency: 'CNY' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('authenticated payment order monitoring', () => {
  beforeEach(() => vi.useFakeTimers())

  it('closes a static QR window only when the account backend confirms this order settled', async () => {
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>()
      .mockResolvedValueOnce('pending').mockResolvedValue('success')
    const createOrderStatusReader = vi.fn(() => reader)
    const harness = createHarness(undefined, '扫码支付\n金额 1.00 CNY', { createOrderStatusReader })
    await harness.controller.openQrCode(qrPayment())

    expect(createOrderStatusReader).toHaveBeenCalledWith('sub2-qr-1')
    expect(reader).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(reader).toHaveBeenCalledOnce()
    expect(harness.window.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'sub2-qr-1' }, inWindow)
    expect(harness.window.destroy.mock.invocationCallOrder[0]).toBeLessThan(harness.onTerminalState.mock.invocationCallOrder[0]!)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it.each(['failed', 'expired'] as const)('closes a static QR window when the server returns %s', async (status) => {
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => async () => status })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status, tradeNo: 'sub2-qr-1' }, inWindow)
    expect(harness.window.destroy).toHaveBeenCalledOnce()
  })

  it('retries network failures and unknown states without prematurely closing the window', async () => {
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>()
      .mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce('unknown').mockResolvedValue('success')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(6_000)
    expect(harness.window.destroy).not.toHaveBeenCalled()
    expect(harness.onTerminalState).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'sub2-qr-1' }, inWindow)
  })

  it('does not overlap queries while an earlier order request is unresolved', async () => {
    const pending = deferred<NewApiTopupOrderStatus>()
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockReturnValueOnce(pending.promise).mockResolvedValue('success')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(reader).toHaveBeenCalledOnce()
    pending.resolve('pending')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'sub2-qr-1' }, inWindow)
  })

  it('ignores an older order response after a replacement window has opened', async () => {
    const oldStatus = deferred<NewApiTopupOrderStatus>()
    const first = createHarness()
    const second = createHarness()
    const onTerminalState = vi.fn()
    const secondReader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockResolvedValue('pending')
    const controller = createPaymentWindowController({
      createWindow: vi.fn().mockReturnValueOnce(first.window).mockReturnValueOnce(second.window),
      createOrderStatusReader: (tradeNo) => tradeNo === 'old' ? () => oldStatus.promise : secondReader,
      onTerminalState,
    })
    await controller.openQrCode(qrPayment('old'))
    await vi.advanceTimersByTimeAsync(3_000)
    await controller.openQrCode(qrPayment('new'))
    oldStatus.resolve('success')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(first.window.destroy).toHaveBeenCalledOnce()
    expect(second.window.destroy).not.toHaveBeenCalled()
    expect(secondReader).toHaveBeenCalledOnce()
    expect(onTerminalState).not.toHaveBeenCalled()
    controller.destroy()
  })

  it.each(['close', 'destroy'] as const)('ignores the in-window order response after controller.%s()', async (action) => {
    const pending = deferred<NewApiTopupOrderStatus>()
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockReturnValueOnce(pending.promise).mockResolvedValue('pending')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(3_000)
    harness.controller[action]()
    pending.resolve('success')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(harness.onTerminalState).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }), expect.anything())
  })

  it('keeps confirming in the background after the in-app close button, but not after destroy()', async () => {
    const closed = createHarness(undefined, '', { createOrderStatusReader: () => async () => 'pending' })
    await closed.controller.openQrCode(qrPayment())
    closed.controller.close()
    expect(closed.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'closed', tradeNo: 'sub2-qr-1', confirming: true }, inWindow)

    const destroyed = createHarness(undefined, '', { createOrderStatusReader: () => async () => 'success' })
    await destroyed.controller.openQrCode(qrPayment())
    destroyed.controller.destroy()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(destroyed.onTerminalState).not.toHaveBeenCalled()
  })

  it('does not turn a late in-window response into success, but a fresh background query may confirm it', async () => {
    const pending = deferred<NewApiTopupOrderStatus>()
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockReturnValueOnce(pending.promise).mockResolvedValue('pending')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(3_000)
    harness.window.close()
    pending.resolve('success')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'closed', tradeNo: 'sub2-qr-1', confirming: true }, inWindow)
    reader.mockResolvedValue('success')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(harness.onTerminalState).toHaveBeenLastCalledWith({ status: 'success', tradeNo: 'sub2-qr-1' }, afterClose)
  })

  it('silently destroys the old payment window and stops polling when account ownership becomes stale', async () => {
    const reader = vi.fn().mockRejectedValue(new RealmAccountError('STALE'))
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(9_000)
    expect(reader).toHaveBeenCalledOnce()
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.onTerminalState).not.toHaveBeenCalled()
  })

  it('cannot be tricked into success by third-party page text', async () => {
    const harness = createHarness(undefined, '支付剩余时间 04:59\n充值成功\n支付成功', {
      createOrderStatusReader: () => async () => 'pending',
    })
    await harness.controller.open(paymentForm())
    await vi.advanceTimersByTimeAsync(9_000)
    expect(harness.window.destroy).not.toHaveBeenCalled()
    expect(harness.onTerminalState).not.toHaveBeenCalled()
    harness.controller.destroy()
  })

  it('expires a QR window at its server deadline even when page inspection never completes', async () => {
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => async () => 'pending' })
    harness.webContents.executeJavaScript.mockReturnValue(new Promise(() => undefined))
    await harness.controller.openQrCode({ ...qrPayment(), expiresAt: new Date(Date.now() + 5_000).toISOString() })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'expired', tradeNo: 'sub2-qr-1' }, inWindow)
    expect(harness.window.destroy).toHaveBeenCalledOnce()
  })

  it('does not resurrect a QR window if destroyed while its image is being prepared', async () => {
    const image = deferred<string>()
    vi.mocked(QRCode.toDataURL).mockReturnValueOnce(image.promise as never)
    const harness = createHarness()
    const opening = harness.controller.openQrCode(qrPayment())
    harness.controller.destroy()
    image.resolve('data:image/png;base64,AA==')
    await opening
    expect(harness.createWindow).not.toHaveBeenCalled()
  })

  it('keeps the replacement monitor running if an older page load fails late', async () => {
    const oldLoad = deferred<void>()
    const first = createHarness()
    const second = createHarness()
    first.window.loadURL.mockReturnValueOnce(oldLoad.promise)
    const onTerminalState = vi.fn()
    const controller = createPaymentWindowController({
      createWindow: vi.fn().mockReturnValueOnce(first.window).mockReturnValueOnce(second.window),
      createOrderStatusReader: () => async () => 'success',
      onTerminalState,
    })
    const firstOpening = controller.openUrl('https://pay.example.com/old', undefined, 'old')
    const rejected = expect(firstOpening).rejects.toThrow('支付页面打开失败')
    await controller.openUrl('https://pay.example.com/new', undefined, 'new')
    oldLoad.reject(new Error('old page load failed'))
    await rejected
    await vi.advanceTimersByTimeAsync(3_000)
    expect(second.window.destroy).toHaveBeenCalledOnce()
    expect(onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'new' }, inWindow)
  })
})

describe('payment page opening', () => {
  beforeEach(() => vi.useFakeTimers())

  it('counts the page as opened once the main frame commits, ignoring a late load failure', async () => {
    const load = deferred<void>()
    const committed = deferred<void>()
    let outcome = 'pending'
    void waitForPaymentPage(load.promise, committed.promise).then(() => { outcome = 'opened' }, () => { outcome = 'failed' })
    committed.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBe('opened')
    // The redirect page navigating to the cashier before its own load event
    // makes Electron reject loadURL with ERR_ABORTED.
    load.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED' }))
    await vi.advanceTimersByTimeAsync(paymentPageOpenTimeoutMs)
    expect(outcome).toBe('opened')
  })

  it('still fails a page that could not load before anything committed', async () => {
    const failure = Object.assign(new Error('ERR_NAME_NOT_RESOLVED (-105)'), { code: 'ERR_NAME_NOT_RESOLVED' })
    await expect(waitForPaymentPage(Promise.reject(failure), new Promise(() => undefined))).rejects.toBe(failure)
  })

  it('gives up on a page that never starts, as a timeout', async () => {
    const opening = waitForPaymentPage(new Promise(() => undefined), new Promise(() => undefined))
    const rejected = expect(opening).rejects.toMatchObject({ code: 'ERR_TIMED_OUT' })
    await vi.advanceTimersByTimeAsync(paymentPageOpenTimeoutMs - 1)
    let settled = false
    void opening.then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
  })

  it('opens and starts confirming the order while a page resource still hangs', async () => {
    const reader = vi.fn(async (): Promise<NewApiTopupOrderStatus> => 'pending')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    harness.window.loadURL.mockReturnValueOnce(new Promise(() => undefined))
    let opened = false
    const opening = harness.controller.openUrl('https://pay.example.com/cashier', undefined, 'XM-1').then(() => { opened = true })

    harness.webContentsEvents.get('did-navigate')!({}, 'https://pay.example.com/cashier')
    await opening
    expect(opened).toBe(true)
    // The first paint is stuck behind a hanging <head> script: show the window anyway.
    expect(harness.window.show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(paymentWindowShowFallbackMs)
    expect(harness.window.center).toHaveBeenCalledOnce()
    expect(harness.window.show).toHaveBeenCalledOnce()
    expect(harness.window.focus).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(reader).toHaveBeenCalled()
    expect(harness.controller.isOpen()).toBe(true)
  })

  it('keeps a committed payment page open when its redirect page reports ERR_ABORTED', async () => {
    const load = deferred<void>()
    const harness = createHarness()
    harness.window.loadURL.mockReturnValueOnce(load.promise)
    const opening = harness.controller.open(paymentForm())
    harness.webContentsEvents.get('did-navigate')!({}, 'https://pay.example.com/submit?channel=alipay')
    await opening
    load.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED' }))
    harness.windowEvents.get('ready-to-show')!()
    await vi.advanceTimersByTimeAsync(paymentWindowShowFallbackMs)
    expect(harness.window.destroy).not.toHaveBeenCalled()
    expect(harness.window.show).toHaveBeenCalledOnce()
    expect(harness.controller.isOpen()).toBe(true)
    expect(harness.onTerminalState).not.toHaveBeenCalled()
  })

  // #1458：乐风码付的收银台 302 落地、画完二维码以后，还会把页面跳去 alipays:// 拉起支付宝 App。
  // 这一跳照旧被拦下，原来那次加载随之报 ERR_ABORTED；收银台已经提交了，不能因此报打不开、关掉窗口。
  it.each([
    ['alipays', alipayAppLaunchUrl],
    ['weixin', weixinAppLaunchUrl],
  ])('keeps the cashier open after it tries to launch the %s app and its load is aborted', async (_scheme, launchUrl) => {
    const reader = vi.fn(async (): Promise<NewApiTopupOrderStatus> => 'pending')
    const load = deferred<void>()
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    harness.window.loadURL.mockReturnValueOnce(load.promise)
    const opening = harness.controller.open(paymentForm())

    const landing = { preventDefault: vi.fn() }
    harness.webContentsEvents.get('will-redirect')!(landing, 'https://pay.example.com/pay/USR1')
    expect(landing.preventDefault).not.toHaveBeenCalled()
    harness.webContentsEvents.get('did-navigate')!({}, 'https://pay.example.com/pay/USR1')
    await expect(opening).resolves.toBeUndefined()

    const launch = { preventDefault: vi.fn() }
    harness.webContentsEvents.get('will-navigate')!(launch, launchUrl)
    expect(launch.preventDefault).toHaveBeenCalledOnce()
    expect(harness.onBlockedNavigation).toHaveBeenCalledExactlyOnceWith(launchUrl)
    load.reject(Object.assign(new Error('ERR_ABORTED (-3) loading \'https://pay.example.com/submit?channel=alipay\''), { code: 'ERR_ABORTED', errno: -3 }))

    await vi.advanceTimersByTimeAsync(paymentWindowShowFallbackMs)
    expect(harness.window.show).toHaveBeenCalledOnce()
    expect(harness.window.destroy).not.toHaveBeenCalled()
    expect(harness.window.close).not.toHaveBeenCalled()
    expect(harness.controller.isOpen()).toBe(true)
    expect(harness.onTerminalState).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(reader).toHaveBeenCalled()
  })

  it('closes a page that never starts and reports it as a timeout', async () => {
    const harness = createHarness()
    harness.window.loadURL.mockReturnValueOnce(new Promise(() => undefined))
    const failure = harness.controller.openUrl('https://pay.example.com/cashier').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(paymentPageOpenTimeoutMs)
    const error = await failure
    expect(error instanceof Error && error.message).toBe('支付页面打开失败，请稍后重试。这次没有扣款，「我的订单」里多出来的订单放着就行。')
    expect(error instanceof Error && error.cause).toEqual({ code: 'ERR_TIMED_OUT' })
    expect(classifyNetworkFailure(error)).toBe('timeout')
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.window.show).not.toHaveBeenCalled()
    expect(harness.controller.isOpen()).toBe(false)
  })

  it('does not show a window that closed before its fallback came due', async () => {
    const harness = createHarness()
    harness.window.loadURL.mockReturnValueOnce(new Promise(() => undefined))
    const opening = harness.controller.openUrl('https://pay.example.com/cashier')
    harness.webContentsEvents.get('did-navigate')!({}, 'https://pay.example.com/cashier')
    await opening
    harness.controller.close()
    await vi.advanceTimersByTimeAsync(paymentWindowShowFallbackMs)
    expect(harness.window.show).not.toHaveBeenCalled()
  })
})

describe('background order confirmation after the payment window closes', () => {
  beforeEach(() => vi.useFakeTimers())

  it('asks every 5 seconds for 2 minutes, then every 30 seconds, and never after 15 minutes', () => {
    expect(paymentFollowUpDelayMs(0)).toBe(5_000)
    expect(paymentFollowUpDelayMs(119_999)).toBe(5_000)
    expect(paymentFollowUpDelayMs(120_000)).toBe(30_000)
    expect(paymentFollowUpDelayMs(paymentFollowUpMaxMs - 10_000)).toBe(10_000)
    expect(paymentFollowUpDelayMs(paymentFollowUpMaxMs)).toBeNull()
    expect(paymentFollowUpDelayMs(Number.NaN)).toBeNull()
  })

  it('keeps asking at the slower cadence and reports settlement after the window is gone', async () => {
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockResolvedValue('pending')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    harness.window.close()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reader).toHaveBeenCalledTimes(24)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(reader).toHaveBeenCalledTimes(24)
    reader.mockResolvedValue('success')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reader).toHaveBeenCalledTimes(25)
    expect(harness.onTerminalState).toHaveBeenLastCalledWith({ status: 'success', tradeNo: 'sub2-qr-1' }, afterClose)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(reader).toHaveBeenCalledTimes(25)
  })

  it.each(['failed', 'expired'] as const)('stops and reports %s from the account backend', async (status) => {
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => async () => status })
    await harness.controller.openQrCode(qrPayment())
    harness.window.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(harness.onTerminalState).toHaveBeenLastCalledWith({ status, tradeNo: 'sub2-qr-1' }, afterClose)
    expect(harness.onTerminalState).toHaveBeenCalledTimes(2)
  })

  it('gives up after 15 minutes with an unconfirmed result and never treats errors as payment', async () => {
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>()
      .mockRejectedValueOnce(new Error('network down')).mockResolvedValue('unknown')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    harness.window.close()
    await vi.advanceTimersByTimeAsync(paymentFollowUpMaxMs - 1)
    expect(harness.onTerminalState).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.onTerminalState).toHaveBeenLastCalledWith({ status: 'unconfirmed', tradeNo: 'sub2-qr-1' }, afterClose)
    const calls = reader.mock.calls.length
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(reader).toHaveBeenCalledTimes(calls)
  })

  it('stops silently when the account changed', async () => {
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockRejectedValue(new RealmAccountError('STALE'))
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    harness.window.close()
    await vi.advanceTimersByTimeAsync(paymentFollowUpMaxMs)
    expect(reader).toHaveBeenCalledOnce()
    expect(harness.onTerminalState).toHaveBeenCalledOnce()
  })

  it('does not overlap queries while a background request is unresolved', async () => {
    const pending = deferred<NewApiTopupOrderStatus>()
    const reader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockReturnValueOnce(pending.promise).mockResolvedValue('pending')
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    harness.window.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reader).toHaveBeenCalledOnce()
    pending.resolve('pending')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('stops following the old order once a new payment opens', async () => {
    const first = createHarness()
    const second = createHarness()
    const onTerminalState = vi.fn()
    const oldReader = vi.fn<() => Promise<NewApiTopupOrderStatus>>().mockResolvedValue('pending')
    const controller = createPaymentWindowController({
      createWindow: vi.fn().mockReturnValueOnce(first.window).mockReturnValueOnce(second.window),
      createOrderStatusReader: (tradeNo) => tradeNo === 'old' ? oldReader : async () => 'pending',
      onTerminalState,
    })
    await controller.openQrCode(qrPayment('old'))
    first.window.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(oldReader).toHaveBeenCalledOnce()
    await controller.openQrCode(qrPayment('new'))
    oldReader.mockResolvedValue('success')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(oldReader).toHaveBeenCalledOnce()
    expect(onTerminalState).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }), expect.anything())
    controller.destroy()
  })

  // #1157 第 15 条：付款页的 beforeunload 能让 close() 不了了之，界面上却已经说关了。
  it('really closes the window for the in-app button even when the payment page refuses to unload', async () => {
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => async () => 'pending' })
    await harness.controller.openQrCode(qrPayment())
    harness.window.close.mockImplementation(() => undefined)

    harness.controller.close()

    expect(harness.window.close).not.toHaveBeenCalled()
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.window.isDestroyed()).toBe(true)
    expect(harness.controller.isOpen()).toBe(false)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'closed', tradeNo: 'sub2-qr-1', confirming: true }, inWindow)
  })

  it('says nothing about background confirmation when there is no order to ask about', async () => {
    const harness = createHarness()
    await harness.controller.open(paymentForm())
    harness.controller.close()
    harness.window.close()
    expect(harness.onTerminalState).not.toHaveBeenCalled()
  })
})
