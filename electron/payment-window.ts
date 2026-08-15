import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from 'electron'
import { randomUUID } from 'node:crypto'
import type { NewApiPaymentForm, NewApiPaymentFormField } from './new-api-client'

const paymentWindowTitle = '安全支付 - 星芒AI管理工具'
const accountOrigin = 'https://xm.solov.cc'

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
}

export interface PaymentWindowController {
  open(form: NewApiPaymentForm, parent?: BrowserWindow): Promise<void>
  openUrl(url: string, parent?: BrowserWindow): Promise<void>
  close(): void
  destroy(): void
  isOpen(): boolean
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

  function release(window: BrowserWindow): void {
    if (paymentWindow === window) paymentWindow = null
  }

  async function openTarget(
    targetUrl: string,
    allowedOrigins: ReadonlySet<string>,
    parent?: BrowserWindow,
    loadOptions?: Electron.LoadURLOptions,
  ): Promise<void> {
    if (paymentWindow && !paymentWindow.isDestroyed()) paymentWindow.destroy()

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
    window.on('closed', () => release(window))
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
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
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
      })
    },
    async openUrl(url, parent) {
      const validated = validatePaymentUrl(url)
      await openTarget(validated.url, validated.allowedOrigins, parent)
    },
    close() {
      if (paymentWindow && !paymentWindow.isDestroyed()) paymentWindow.close()
    },
    destroy() {
      if (paymentWindow && !paymentWindow.isDestroyed()) paymentWindow.destroy()
      paymentWindow = null
    },
    isOpen() {
      return Boolean(paymentWindow && !paymentWindow.isDestroyed())
    },
  }
}
