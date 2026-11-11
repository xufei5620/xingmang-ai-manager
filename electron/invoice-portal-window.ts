// 「我的订单」的「开发票」：在软件里开一个开票窗口，显示当前账号的开票中心（xingmang-console 仓库的客户门户）。
// 客户在窗口里用同一个账号密码登录、勾订单申请、下载发票；开票规则全在那边，这里只管窗口守得住。
// yoyo 2026-11-11 回「窗口改」定的这条路，界面上的六句字是那天批的原字。
import {
  BrowserWindow,
  dialog,
  session as electronSession,
  type BrowserWindowConstructorOptions,
  type DownloadItem,
  type MessageBoxOptions,
  type SaveDialogOptions,
  type Session,
  type WebContents,
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { readBoundedFile } from './bounded-file'
import { networkFailureCode } from './network-failure'
import { waitForPaymentPage } from './payment-window'
import { resolveRelaySite } from './relay-sites'
import { ensureSafeDataDirectory, removeSafeDataFile, writeAtomicSafeBinaryFile } from './safe-local-data'

export const invoicePortalWindowTitle = '开票中心 - 星芒AI'
export const invoicePortalOpenFailedMessage = '没能打开开票中心，请稍后再试；还不行请找客服。'
export const invoiceSaveDialogTitle = '保存发票'
export const invoiceSaveFailedMessage = '发票没保存下来，请再点一次「下载发票」；还不行请找客服。'
export const invoiceSaveFailedButton = '知道了'
// 开票那边只收 8MB 以内的 PDF、PNG、JPEG 作发票文件（modules/invoices 的发票文件一节），多出来的不是发票。
export const invoiceDocumentMaxBytes = 8 * 1024 * 1024

export interface InvoicePortalIdentity {
  siteId: string
  userId: number
}

export interface InvoicePortalTarget {
  url: string
  origin: string
}

export type InvoiceDocumentType = 'pdf' | 'png' | 'jpeg'

export interface InvoiceDownloadFacts {
  url: string
  mimeType: string
  totalBytes: number
}

/** 当前账号的开票中心在哪；这个站没有开票中心、或者表里的地址不是干净的 https 时返回 null。 */
export function resolveInvoicePortalTarget(siteId: string): InvoicePortalTarget | null {
  const site = resolveRelaySite(siteId)
  if (site.id !== siteId || !site.invoicePortalUrl) return null
  let parsed: URL
  try {
    parsed = new URL(site.invoicePortalUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null
  return { url: parsed.href, origin: parsed.origin }
}

/**
 * 每个账号一份自己的登录记录（Electron 的持久分区），开票中心的登录只在这一份里：换了账号看不到上一个人
 * 的发票，同一个账号关了软件再开还记得。分区名用站点和用户编号的摘要，不把编号直接写进目录名。
 */
export function buildInvoicePortalPartition(identity: InvoicePortalIdentity): string {
  const digest = createHash('sha256').update(`${identity.siteId}:${identity.userId}`).digest('hex').slice(0, 32)
  return `persist:xingmang-invoice-${digest}`
}

export function sameInvoicePortalIdentity(a: InvoicePortalIdentity | null, b: InvoicePortalIdentity | null): boolean {
  if (!a || !b) return a === b
  return a.siteId === b.siteId && a.userId === b.userId
}

/**
 * The portal is a third-party-maintained page we do not control. The window
 * may only ever show that one exact origin: a navigation anywhere else (an
 * account site, a phishing look-alike, a plain-HTTP downgrade) would put a
 * page the customer cannot vet behind our "开票中心 - 星芒AI" title.
 */
export function isAllowedInvoicePortalNavigation(value: string, origin: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.origin === origin
  } catch {
    return false
  }
}

const invoiceDocumentMimeTypes: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg'])

/**
 * 下载发票之前先看这一下是不是开票中心页面自己发起的发票文件。开票中心的「下载发票」是页面先把文件读进来，
 * 再用 blob: 地址存（portal-web 的 CustomerPortal.tsx），所以只认这个 origin 底下的 blob: 地址。类型报空的
 * 也先放过，文件到了以后按开头几个字节再认一次（resolveInvoiceDocumentType），那一下才算数。
 */
export function isAcceptableInvoiceDownload(facts: InvoiceDownloadFacts, origin: string): boolean {
  if (!facts.url.startsWith(`blob:${origin}/`)) return false
  const mimeType = facts.mimeType.split(';')[0]!.trim().toLowerCase()
  if (mimeType !== '' && !invoiceDocumentMimeTypes.has(mimeType)) return false
  return Number.isSafeInteger(facts.totalBytes) && facts.totalBytes >= 0 && facts.totalBytes <= invoiceDocumentMaxBytes
}

/** 按文件开头的几个字节认发票文件；不是 PDF、PNG、JPEG 的返回 null。 */
export function resolveInvoiceDocumentType(bytes: Buffer): InvoiceDocumentType | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return null
}

const invoiceDocumentExtensions: Readonly<Record<InvoiceDocumentType, string>> = { pdf: 'pdf', png: 'png', jpeg: 'jpg' }

/**
 * 保存框里默认的文件名。名字是开票中心页面给的（invoice-<申请编号>.pdf），只留字母、数字和 .-_，
 * 扩展名按实际认出来的类型换，不让页面给的名字决定存成什么。
 */
export function buildInvoiceSaveName(suggested: string, type: InvoiceDocumentType): string {
  const base = path.basename(suggested.replace(/\\/g, '/')).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100)
  return `${base || 'invoice'}.${invoiceDocumentExtensions[type]}`
}

export interface InvoicePortalWindowControllerOptions {
  iconPath?: string
  /** 下载发票先落在这里（主进程自己的数据目录下），认过类型再由客户选位置另存。 */
  temporaryDirectory(): string
  /** 保存框默认打开的文件夹（「下载」）。 */
  downloadsDirectory(): string
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow
  sessionFromPartition?: (partition: string) => Session
  showSaveDialog?: (window: BrowserWindow, options: SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  showMessageBox?: (window: BrowserWindow, options: MessageBoxOptions) => Promise<unknown>
  onBlockedNavigation?: (url: string) => void
  /** 只记原因的错误码和类别，不记地址和文件名。 */
  onEvent?: (event: InvoicePortalWindowEvent) => void
}

export type InvoicePortalWindowEvent =
  | { kind: 'download.rejected' }
  | { kind: 'download.failed'; code: string }
  | { kind: 'download.saved'; type: InvoiceDocumentType; bytes: number }
  | { kind: 'storage.clear-failed'; code: string }

export interface InvoicePortalWindowController {
  /** 打开（或拉到前面）这个账号的开票窗口；开票中心第一屏没起来就关掉窗口、抛 invoicePortalOpenFailedMessage。 */
  open(identity: InvoicePortalIdentity): Promise<void>
  /** 当前登录的是谁。换了人或退出：关掉开票窗口，清掉上一个人的开票登录。 */
  setAccount(identity: InvoicePortalIdentity | null): void
  destroy(): void
  isOpen(): boolean
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN'
}

export function createInvoicePortalWindowController(options: InvoicePortalWindowControllerOptions): InvoicePortalWindowController {
  const createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions))
  const sessionFromPartition = options.sessionFromPartition ?? ((partition) => electronSession.fromPartition(partition))
  const showSaveDialog = options.showSaveDialog ?? ((window, dialogOptions) => dialog.showSaveDialog(window, dialogOptions))
  const showMessageBox = options.showMessageBox ?? ((window, boxOptions) => dialog.showMessageBox(window, boxOptions))
  let current: { window: BrowserWindow; identity: InvoicePortalIdentity; origin: string } | null = null
  let account: InvoicePortalIdentity | null = null
  let opening: { identity: InvoicePortalIdentity; promise: Promise<void> } | null = null
  const hardenedSessions = new WeakSet<Session>()

  function release(window: BrowserWindow): void {
    if (current?.window === window) current = null
  }

  function destroyWindow(window: BrowserWindow): void {
    release(window)
    if (!window.isDestroyed()) window.destroy()
  }

  function reportSaveFailed(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    void showMessageBox(window, {
      type: 'error',
      title: invoicePortalWindowTitle,
      message: invoiceSaveFailedMessage,
      buttons: [invoiceSaveFailedButton],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).catch(() => undefined)
  }

  async function finishDownload(window: BrowserWindow, item: DownloadItem, temporaryPath: string): Promise<void> {
    try {
      const bytes = await readBoundedFile(temporaryPath, invoiceDocumentMaxBytes, '发票文件')
      await removeSafeDataFile(temporaryPath, '发票文件').catch(() => undefined)
      const type = resolveInvoiceDocumentType(bytes)
      if (!type) {
        options.onEvent?.({ kind: 'download.rejected' })
        reportSaveFailed(window)
        return
      }
      if (window.isDestroyed()) return
      const result = await showSaveDialog(window, {
        title: invoiceSaveDialogTitle,
        defaultPath: path.join(options.downloadsDirectory(), buildInvoiceSaveName(item.getFilename(), type)),
      })
      if (result.canceled || !result.filePath) return
      await writeAtomicSafeBinaryFile(result.filePath, bytes, '发票文件')
      options.onEvent?.({ kind: 'download.saved', type, bytes: bytes.length })
    } catch (error) {
      options.onEvent?.({ kind: 'download.failed', code: errorCode(error) })
      reportSaveFailed(window)
    } finally {
      await removeSafeDataFile(temporaryPath, '发票文件').catch(() => undefined)
    }
  }

  // The session outlives every window built on it (it is persistent), so the
  // guards are installed once per session. They always consult `current`:
  // a download is only honoured from the live invoice window's own page.
  function hardenSession(target: Session): void {
    if (hardenedSessions.has(target)) return
    hardenedSessions.add(target)
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    target.setPermissionCheckHandler(() => false)
    target.setDevicePermissionHandler(() => false)
    target.on('will-download', (event: Electron.Event, item: DownloadItem, contents: WebContents) => {
      const live = current
      if (!live || live.window.isDestroyed() || live.window.webContents !== contents) {
        event.preventDefault()
        return
      }
      const facts = { url: item.getURL(), mimeType: item.getMimeType(), totalBytes: item.getTotalBytes() }
      if (!isAcceptableInvoiceDownload(facts, live.origin)) {
        event.preventDefault()
        options.onEvent?.({ kind: 'download.rejected' })
        reportSaveFailed(live.window)
        return
      }
      let temporaryPath: string
      try {
        const directory = options.temporaryDirectory()
        ensureSafeDataDirectory(directory, '发票下载目录')
        temporaryPath = path.join(directory, `${randomUUID()}.download`)
      } catch (error) {
        event.preventDefault()
        options.onEvent?.({ kind: 'download.failed', code: errorCode(error) })
        reportSaveFailed(live.window)
        return
      }
      // Must be set synchronously inside will-download, or Chromium falls back
      // to its own save dialog and writes straight to the chosen path, past
      // our type check and atomic write.
      item.setSavePath(temporaryPath)
      const window = live.window
      item.once('done', (_doneEvent, state) => {
        if (state === 'completed') {
          void finishDownload(window, item, temporaryPath)
          return
        }
        void removeSafeDataFile(temporaryPath, '发票文件').catch(() => undefined)
        options.onEvent?.({ kind: 'download.failed', code: state === 'cancelled' ? 'CANCELLED' : 'INTERRUPTED' })
        reportSaveFailed(window)
      })
    })
  }

  function clearStorage(identity: InvoicePortalIdentity): void {
    try {
      const target = sessionFromPartition(buildInvoicePortalPartition(identity))
      void Promise.all([target.clearStorageData(), target.clearCache()]).catch((error: unknown) => {
        options.onEvent?.({ kind: 'storage.clear-failed', code: errorCode(error) })
      })
    } catch (error) {
      options.onEvent?.({ kind: 'storage.clear-failed', code: errorCode(error) })
    }
  }

  async function openWindow(identity: InvoicePortalIdentity, target: InvoicePortalTarget): Promise<void> {
    const window = createWindow({
      // 不挂在主窗口上：开票要填资料、来回看记录，客户会把它和主窗口来回切；挂上了它永远压在主窗口前面。
      width: 1180,
      height: 820,
      minWidth: 860,
      minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#f5f6f7',
      title: invoicePortalWindowTitle,
      ...(options.iconPath ? { icon: options.iconPath } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        partition: buildInvoicePortalPartition(identity),
        spellcheck: false,
        safeDialogs: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    current = { window, identity, origin: target.origin }
    hardenSession(window.webContents.session)

    let shown = false
    const reveal = () => {
      if (shown || window.isDestroyed()) return
      shown = true
      window.center()
      window.show()
      window.focus()
    }
    window.once('ready-to-show', reveal)
    window.on('closed', () => release(window))
    window.on('page-title-updated', (event) => {
      event.preventDefault()
      if (!window.isDestroyed()) window.setTitle(invoicePortalWindowTitle)
    })
    let markCommitted = () => {}
    const committed = new Promise<void>((resolve) => { markCommitted = resolve })
    window.webContents.on('did-navigate', () => markCommitted())
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedInvoicePortalNavigation(url, target.origin)) options.onBlockedNavigation?.(url)
      return { action: 'deny' }
    })
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isAllowedInvoicePortalNavigation(url, target.origin)) return
      event.preventDefault()
      options.onBlockedNavigation?.(url)
    }
    window.webContents.on('will-navigate', guardNavigation)
    window.webContents.on('will-redirect', guardNavigation)

    try {
      await waitForPaymentPage(window.loadURL(target.url), committed)
    } catch (error) {
      destroyWindow(window)
      throw new Error(invoicePortalOpenFailedMessage, { cause: { code: networkFailureCode(error) } })
    }
    if (window.isDestroyed() || current?.window !== window) throw new Error(invoicePortalOpenFailedMessage)
    // 第一屏迟迟画不出来（一个脚本卡在半路）也先把窗口亮出来，同付款窗口。
    setTimeout(reveal, 1_500).unref?.()
  }

  return {
    open(identity) {
      const target = resolveInvoicePortalTarget(identity.siteId)
      if (!target) return Promise.reject(new Error(invoicePortalOpenFailedMessage))
      if (account && !sameInvoicePortalIdentity(account, identity)) return Promise.reject(new Error(invoicePortalOpenFailedMessage))
      const live = current
      if (live && !live.window.isDestroyed() && sameInvoicePortalIdentity(live.identity, identity)) {
        // 已经开着：双击、或者从「我的订单」再点一次，拉到前面就行，不重新加载（客户可能正填着资料）。
        if (opening && sameInvoicePortalIdentity(opening.identity, identity)) return opening.promise
        if (live.window.isMinimized()) live.window.restore()
        live.window.show()
        live.window.focus()
        return Promise.resolve()
      }
      if (live) destroyWindow(live.window)
      const promise = openWindow(identity, target).finally(() => {
        if (opening?.promise === promise) opening = null
      })
      opening = { identity, promise }
      return promise
    },
    setAccount(identity) {
      if (sameInvoicePortalIdentity(account, identity)) return
      const previous = account
      account = identity ? { siteId: identity.siteId, userId: identity.userId } : null
      if (current && !sameInvoicePortalIdentity(current.identity, identity)) destroyWindow(current.window)
      if (previous) clearStorage(previous)
    },
    destroy() {
      if (current) destroyWindow(current.window)
    },
    isOpen() {
      return Boolean(current && !current.window.isDestroyed())
    },
  }
}
