import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}))

import type { NewApiPaymentForm } from './new-api-client'
import {
  createPaymentWindowController,
  isAllowedPaymentNavigationUrl,
  paymentFormLimits,
  validatePaymentForm,
  validatePaymentUrl,
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

function createHarness(loadError?: Error) {
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
    destroy: vi.fn(() => { destroyed = true }),
    setTitle: vi.fn(),
  }
  const createWindow = vi.fn(() => window as never)
  const onBlockedNavigation = vi.fn()
  const controller = createPaymentWindowController({ createWindow, onBlockedNavigation })
  return {
    controller,
    createWindow,
    onBlockedNavigation,
    session,
    sessionEvents,
    webContents,
    webContentsEvents,
    window,
    windowEvents,
  }
}

beforeEach(() => vi.clearAllMocks())

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
      title: '安全支付 - 星芒AI管理工具',
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
    expect(harness.controller.isOpen()).toBe(true)
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
    expect(graceful.controller.isOpen()).toBe(false)

    const forced = createHarness()
    await forced.controller.open(paymentForm())
    forced.controller.destroy()
    expect(forced.window.destroy).toHaveBeenCalledOnce()
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
