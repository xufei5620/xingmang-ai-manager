import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AA==') } }))

import QRCode from 'qrcode'
import type { NewApiPaymentForm, NewApiTopupOrderStatus } from './new-api-client'
import { RealmAccountError } from './realm-account'
import {
  createPaymentWindowController,
  detectPaymentWindowTerminalStatus,
  isAllowedPaymentNavigationUrl,
  isPaymentWindowReady,
  paymentFormLimits,
  validatePaymentForm,
  validatePaymentUrl,
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

function createHarness(loadError?: Error, terminalSnapshot = '', options: Pick<PaymentWindowControllerOptions, 'createOrderStatusReader'> = {}) {
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
    expect(() => validatePaymentForm(paymentForm(overrides))).toThrow()
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
    const harness = createHarness()
    const parent = {} as never

    await harness.controller.open(paymentForm(), parent)

    expect(harness.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      parent,
      modal: true,
      show: false,
      title: '安全支付 - 星芒AI',
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
    expect(harness.window.setTitle).toHaveBeenCalledWith('安全支付 - 星芒AI')
    expect(harness.controller.isOpen()).toBe(true)
  })

  it('closes the window and reports the matching trade number when the provider page expires', async () => {
    const harness = createHarness(undefined, '支付剩余时间\n00:00\n支付超时后，请重新创建订单')

    await harness.controller.open(paymentForm())
    await vi.waitFor(() => expect(harness.onTerminalState).toHaveBeenCalledWith({
      status: 'expired',
      tradeNo: 'XM-20260815-1',
    }))
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
    })
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

  it('supports graceful close and force destroy', async () => {
    const graceful = createHarness()
    await graceful.controller.open(paymentForm())
    graceful.controller.close()
    expect(graceful.window.close).toHaveBeenCalledOnce()
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
      '支付页面打开失败，请稍后重试',
    )
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.controller.isOpen()).toBe(false)
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
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'sub2-qr-1' })
    expect(harness.window.destroy.mock.invocationCallOrder[0]).toBeLessThan(harness.onTerminalState.mock.invocationCallOrder[0]!)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it.each(['failed', 'expired'] as const)('closes a static QR window when the server returns %s', async (status) => {
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => async () => status })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status, tradeNo: 'sub2-qr-1' })
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
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'sub2-qr-1' })
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
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'sub2-qr-1' })
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

  it.each(['close', 'destroy'] as const)('ignores an order response after controller.%s()', async (action) => {
    const pending = deferred<NewApiTopupOrderStatus>()
    const reader = vi.fn(() => pending.promise)
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => reader })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(3_000)
    harness.controller[action]()
    pending.resolve('success')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(reader).toHaveBeenCalledOnce()
    expect(harness.onTerminalState).not.toHaveBeenCalled()
  })

  it('does not turn a late response into success after the user manually closes the window', async () => {
    const pending = deferred<NewApiTopupOrderStatus>()
    const harness = createHarness(undefined, '', { createOrderStatusReader: () => () => pending.promise })
    await harness.controller.openQrCode(qrPayment())
    await vi.advanceTimersByTimeAsync(3_000)
    harness.window.close()
    pending.resolve('success')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'closed', tradeNo: 'sub2-qr-1' })
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
    expect(harness.onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'expired', tradeNo: 'sub2-qr-1' })
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
    expect(onTerminalState).toHaveBeenCalledExactlyOnceWith({ status: 'success', tradeNo: 'new' })
  })
})
