import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from 'electron'
import { randomUUID } from 'node:crypto'
import type { NewApiPaymentForm, NewApiPaymentFormField } from './new-api-client'

const accountOrigin = 'https://xm.solov.cc'
const paymentWindowTitle = '安全支付 - 星芒AI'
const paymentWindowMonitorIntervalMs = 1_000
const paymentWindowMaxLifetimeMs = 10 * 60_000
const paymentPageSnapshotLimit = 8_192

export type PaymentWindowTerminalStatus = 'expired' | 'failed' | 'closed'

export interface PaymentWindowTerminalEvent {
  status: PaymentWindowTerminalStatus
  tradeNo: string | null
}

export const paymentFormLimits = Object.freeze({
  actionLength: 2_048,
  fieldCount: 64,
  fieldNameLength: 80,
  fieldValueLength: 4_096,
  totalLength: 64 * 1_024,
  tradeNoLength: 255,
})

const paymentFieldNamePattern = /^[A-Za-z0-9_.:-]+$/

export interface ValidatedPaymentForm {
  action: string
  actionOrigin: string
  allowedOrigins: ReadonlySet<string>
  encodedBody: string
  fields: readonly Readonly<NewApiPaymentFormField>[]
  tradeNo: string | null
}

export interface PaymentWindowControllerOptions {
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow
  onBlockedNavigation?: (url: string) => void
  onTerminalState?: (event: PaymentWindowTerminalEvent) => void
}

export interface PaymentWindowController {
  open(form: NewApiPaymentForm, parent?: BrowserWindow): Promise<void>
  openUrl(url: string, parent?: BrowserWindow, tradeNo?: string | null): Promise<void>
  close(): void
  destroy(): void
  isOpen(): boolean
}

const terminalPaymentPatterns: ReadonlyArray<readonly [PaymentWindowTerminalStatus, RegExp]> = [
  ['expired', /^(?:订单|支付|二维码)(?:已)?(?:超时|过期|失效)(?=$|[，。!！:：])/u],
  ['expired', /^(?:交易|订单)(?:已)?关闭(?=$|[，。!！:：])/u],
  ['failed', /^(?:支付|交易|订单)(?:已)?失败(?=$|[，。!！:：])/u],
]

export function detectPaymentWindowTerminalStatus(value: unknown): PaymentWindowTerminalStatus | null {
  if (typeof value !== 'string') return null
  const lines = value
    .slice(0, paymentPageSnapshotLimit)
    .split(/\r?\n/gu)
    .map((line) => line.replace(/\s+/gu, ''))
    .filter(Boolean)
  if (lines.some((line) => /^0{1,3}:00$/u.test(line))) return 'expired'
  for (const line of lines) {
    const status = terminalPaymentPatterns.find(([, pattern]) => pattern.test(line))?.[0]
    if (status) return status
  }
  return null
}

export function isPaymentWindowReady(value: unknown): boolean {
  if (typeof value !== 'string' || /Na\s*:\s*Na/iu.test(value)) return false
  return /(?:^|\D)\d{1,3}:\d{2}(?:\D|$)/u.test(value)
    || /\d{1,3}\s*分\s*\d{1,2}\s*秒/u.test(value)
}

function parseCredentialFreeHttpsUrl(value: unknown, label: string, allowFragment = false): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > paymentFormLimits.actionLength) {
    throw new Error(`${label}格式异常`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label}格式异常`)
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || (!allowFragment && parsed.hash !== '')
  ) {
    throw new Error(`${label}必须是不含账号密码和片段的 HTTPS 地址`)
  }
  return parsed
}

export interface ValidatedPaymentUrl {
  url: string
  allowedOrigins: ReadonlySet<string>
}

export function validatePaymentUrl(value: string): ValidatedPaymentUrl {
  const parsed = parseCredentialFreeHttpsUrl(value, '支付地址', true)
  return Object.freeze({
    url: parsed.href,
    allowedOrigins: new Set([accountOrigin, parsed.origin]),
  })
}

function validateFields(value: unknown): readonly Readonly<NewApiPaymentFormField>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > paymentFormLimits.fieldCount) {
    throw new Error('支付表单字段数量异常')
  }

  let totalLength = 0
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('支付表单字段格式异常')
    const field = candidate as { name?: unknown; value?: unknown }
    if (
      typeof field.name !== 'string'
      || field.name.length === 0
      || field.name.length > paymentFormLimits.fieldNameLength
      || !paymentFieldNamePattern.test(field.name)
    ) {
      throw new Error('支付表单字段名称异常')
    }
    if (typeof field.value !== 'string' || field.value.length > paymentFormLimits.fieldValueLength) {
      throw new Error('支付表单字段内容异常')
    }
    totalLength += Buffer.byteLength(field.name, 'utf8') + Buffer.byteLength(field.value, 'utf8')
    if (totalLength > paymentFormLimits.totalLength) throw new Error('支付表单内容超过安全上限')
    return Object.freeze({ name: field.name, value: field.value })
  })
}

/**
 * Revalidates the server-returned form at the BrowserWindow trust boundary.
 * The renderer never builds payment HTML or receives a scriptable payload.
 */
export function validatePaymentForm(form: NewApiPaymentForm): ValidatedPaymentForm {
  if (!form || typeof form !== 'object') throw new Error('支付表单格式异常')
  if (form.method !== 'POST') throw new Error('支付表单仅允许 POST 提交')

  const action = parseCredentialFreeHttpsUrl(form.action, '支付地址')
  const declaredOrigin = parseCredentialFreeHttpsUrl(form.allowedOrigin, '支付来源')
  if (
    declaredOrigin.origin !== action.origin
    || declaredOrigin.pathname !== '/'
    || declaredOrigin.search !== ''
    || declaredOrigin.hash !== ''
  ) {
    throw new Error('支付来源与支付地址不匹配')
  }

  const fields = validateFields(form.fields)
  const tradeNo = form.tradeNo === null
    ? null
    : typeof form.tradeNo === 'string' && form.tradeNo.length <= paymentFormLimits.tradeNoLength
      ? form.tradeNo
      : (() => { throw new Error('支付订单号格式异常') })()
  const encodedBody = new URLSearchParams(fields.map((field) => [field.name, field.value])).toString()
  if (Buffer.byteLength(encodedBody, 'utf8') > paymentFormLimits.totalLength) {
    throw new Error('支付表单编码后内容超过安全上限')
  }

  return Object.freeze({
    action: action.href,
    actionOrigin: action.origin,
    allowedOrigins: new Set([accountOrigin, action.origin]),
    encodedBody,
    fields: Object.freeze(fields),
    tradeNo,
  })
}

export function isAllowedPaymentNavigationUrl(
  value: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && allowedOrigins.has(parsed.origin)
  } catch {
    return false
  }
}

export function createPaymentWindowController(
  options: PaymentWindowControllerOptions = {},
): PaymentWindowController {
  const createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions))
  let paymentWindow: BrowserWindow | null = null
  let monitorTimer: NodeJS.Timeout | null = null
  const silentClosures = new WeakSet<BrowserWindow>()

  function stopMonitoring(): void {
    if (monitorTimer) clearInterval(monitorTimer)
    monitorTimer = null
  }

  function release(window: BrowserWindow): void {
    if (paymentWindow !== window) return
    stopMonitoring()
    paymentWindow = null
  }

  function destroySilently(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    silentClosures.add(window)
    window.destroy()
  }

  function closeSilently(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    silentClosures.add(window)
    window.close()
  }

  async function openTarget(
    targetUrl: string,
    allowedOrigins: ReadonlySet<string>,
    parent?: BrowserWindow,
    loadOptions?: Electron.LoadURLOptions,
    tradeNo: string | null = null,
  ): Promise<void> {
    stopMonitoring()
    if (paymentWindow && !paymentWindow.isDestroyed()) destroySilently(paymentWindow)

    const window = createWindow({
      parent,
      modal: Boolean(parent),
      width: 760,
      height: 820,
      minWidth: 560,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f5f6f7',
      title: paymentWindowTitle,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        partition: `xingmang-payment-${randomUUID()}`,
        spellcheck: false,
        safeDialogs: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    paymentWindow = window

    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.session.setDevicePermissionHandler(() => false)
    window.webContents.session.on('will-download', (event) => event.preventDefault())

    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return
      window.center()
      window.show()
      window.focus()
    })
    window.on('closed', () => {
      const wasActive = paymentWindow === window
      const wasSilent = silentClosures.delete(window)
      release(window)
      if (wasActive && !wasSilent) options.onTerminalState?.({ status: 'closed', tradeNo })
    })
    window.on('page-title-updated', (event) => {
      event.preventDefault()
      if (!window.isDestroyed()) window.setTitle(paymentWindowTitle)
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedPaymentNavigationUrl(url, allowedOrigins)) options.onBlockedNavigation?.(url)
      return { action: 'deny' }
    })
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isAllowedPaymentNavigationUrl(url, allowedOrigins)) return
      event.preventDefault()
      options.onBlockedNavigation?.(url)
    }
    window.webContents.on('will-navigate', guardNavigation)
    window.webContents.on('will-redirect', guardNavigation)

    try {
      await window.loadURL(targetUrl, loadOptions)
      if (window.isDestroyed() || paymentWindow !== window) return

      const openedAt = Date.now()
      let inspectionInFlight = false
      let terminalDetectionArmed = false
      const finish = (status: PaymentWindowTerminalStatus) => {
        if (window.isDestroyed() || paymentWindow !== window) return
        stopMonitoring()
        // BrowserWindow.close() can be cancelled by a third-party beforeunload
        // handler. Destroy first so the UI never reports a window still open.
        destroySilently(window)
        release(window)
        options.onTerminalState?.({ status, tradeNo })
      }
      const inspect = async () => {
        if (inspectionInFlight || window.isDestroyed() || paymentWindow !== window) return
        if (Date.now() - openedAt >= paymentWindowMaxLifetimeMs) {
          finish('expired')
          return
        }
        inspectionInFlight = true
        try {
          const snapshot = await window.webContents.executeJavaScript(`(() => {
            const title = typeof document.title === 'string' ? document.title : '';
            const body = typeof document.body?.innerText === 'string' ? document.body.innerText : '';
            return (title + '\\n' + body).slice(0, ${paymentPageSnapshotLimit});
          })()`, true)
          if (!terminalDetectionArmed) {
            terminalDetectionArmed = isPaymentWindowReady(snapshot)
            if (!terminalDetectionArmed) return
          }
          const status = detectPaymentWindowTerminalStatus(snapshot)
          if (status) finish(status)
        } catch {
          // Third-party pages may block inspection while navigating; the next bounded tick retries.
        } finally {
          inspectionInFlight = false
        }
      }
      monitorTimer = setInterval(() => void inspect(), paymentWindowMonitorIntervalMs)
      monitorTimer.unref?.()
      void inspect()
    } catch (error) {
      stopMonitoring()
      if (!window.isDestroyed()) destroySilently(window)
      release(window)
      throw new Error('支付页面打开失败，请稍后重试', { cause: error })
    }
  }

  return {
    async open(form, parent) {
      const validated = validatePaymentForm(form)
      await openTarget(validated.action, validated.allowedOrigins, parent, {
          extraHeaders: 'Content-Type: application/x-www-form-urlencoded\r\nCache-Control: no-store\r\n',
          postData: [{
            type: 'rawData',
            bytes: Buffer.from(validated.encodedBody, 'utf8'),
          }],
      }, validated.tradeNo)
    },
    async openUrl(url, parent, tradeNo = null) {
      const validated = validatePaymentUrl(url)
      await openTarget(validated.url, validated.allowedOrigins, parent, undefined, tradeNo)
    },
    close() {
      if (paymentWindow && !paymentWindow.isDestroyed()) closeSilently(paymentWindow)
    },
    destroy() {
      const window = paymentWindow
      if (window && !window.isDestroyed()) destroySilently(window)
      if (window) release(window)
    },
    isOpen() {
      return Boolean(paymentWindow && !paymentWindow.isDestroyed())
    },
  }
}
