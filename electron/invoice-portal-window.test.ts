import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  dialog: {},
  session: {},
}))

import {
  buildInvoicePortalPartition,
  buildInvoiceSaveName,
  createInvoicePortalWindowController,
  invoiceDocumentMaxBytes,
  invoicePortalOpenFailedMessage,
  invoicePortalWindowTitle,
  invoiceSaveDialogTitle,
  invoiceSaveFailedButton,
  invoiceSaveFailedMessage,
  isAcceptableInvoiceDownload,
  isAllowedInvoicePortalNavigation,
  resolveInvoiceDocumentType,
  resolveInvoicePortalTarget,
  sameInvoicePortalIdentity,
  type InvoicePortalWindowControllerOptions,
} from './invoice-portal-window'

const xmOrigin = 'https://invoice-xm.solov.cc'
const xmAccount = { siteId: 'solov', userId: 7 }
const pdfBytes = Buffer.from('%PDF-1.7\n%fake invoice\n')

let scratch: string

beforeEach(() => {
  vi.clearAllMocks()
  // realpath: on macOS the temp folder sits behind the /var -> /private/var
  // link, which the safe-write helpers refuse by design.
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-invoice-window-')))
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

function createHarness(options: Partial<InvoicePortalWindowControllerOptions> & { loadError?: Error } = {}) {
  const windowEvents = new Map<string, (...args: any[]) => void>()
  const webContentsEvents = new Map<string, (...args: any[]) => void>()
  const sessionEvents = new Map<string, (...args: any[]) => void>()
  let destroyed = false
  const session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setProxy: vi.fn(async (_config: { mode: string }) => undefined),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => sessionEvents.set(name, handler)),
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
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
    loadURL: vi.fn(async (_url: string) => {
      if (options.loadError) throw options.loadError
      windowEvents.get('ready-to-show')?.()
    }),
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    center: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(() => {
      destroyed = true
      windowEvents.get('closed')?.()
    }),
    setTitle: vi.fn(),
  }
  const createWindow = vi.fn(() => window as never)
  const sessionFromPartition = vi.fn((_partition: string) => session as never)
  const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: path.join(scratch, 'saved', 'my-invoice.pdf') }))
  const showMessageBox = vi.fn(async () => ({ response: 0 }))
  const onBlockedNavigation = vi.fn()
  const onEvent = vi.fn()
  const { loadError: _loadError, ...overrides } = options
  const controller = createInvoicePortalWindowController({
    temporaryDirectory: () => path.join(scratch, 'invoice-downloads'),
    downloadsDirectory: () => path.join(scratch, 'Downloads'),
    createWindow,
    sessionFromPartition,
    showSaveDialog,
    showMessageBox,
    onBlockedNavigation,
    onEvent,
    ...overrides,
  })
  return {
    controller,
    createWindow,
    sessionFromPartition,
    showSaveDialog,
    showMessageBox,
    onBlockedNavigation,
    onEvent,
    session,
    sessionEvents,
    webContents,
    webContentsEvents,
    window,
    windowEvents,
  }
}

function downloadItem(facts: { url: string; mimeType?: string; totalBytes?: number; filename?: string }) {
  const events = new Map<string, (...args: any[]) => void>()
  const item = {
    getURL: () => facts.url,
    getMimeType: () => facts.mimeType ?? 'application/pdf',
    getTotalBytes: () => facts.totalBytes ?? pdfBytes.length,
    getFilename: () => facts.filename ?? 'invoice-0b4c.pdf',
    setSavePath: vi.fn(),
    once: vi.fn((name: string, handler: (...args: any[]) => void) => events.set(name, handler)),
  }
  return { item, events }
}

function startDownload(harness: ReturnType<typeof createHarness>, facts: Parameters<typeof downloadItem>[0], contents: unknown = harness.webContents) {
  const download = downloadItem(facts)
  const event = { preventDefault: vi.fn() }
  harness.sessionEvents.get('will-download')!(event, download.item, contents)
  return { ...download, event }
}

describe('resolveInvoicePortalTarget', () => {
  it('sends each account site to its own invoice portal', () => {
    expect(resolveInvoicePortalTarget('solov')).toEqual({ url: `${xmOrigin}/orders`, origin: xmOrigin })
    expect(resolveInvoicePortalTarget('solov-api')).toEqual({
      url: 'https://invoice-api.solov.cc/orders',
      origin: 'https://invoice-api.solov.cc',
    })
  })

  it('refuses a site it does not know instead of falling back to the default one', () => {
    expect(resolveInvoicePortalTarget('solov-evil')).toBeNull()
    expect(resolveInvoicePortalTarget('')).toBeNull()
  })
})

describe('buildInvoicePortalPartition', () => {
  it('keeps one persistent login per account without writing the user id into the name', () => {
    const partition = buildInvoicePortalPartition(xmAccount)
    expect(partition).toMatch(/^persist:xingmang-invoice-[0-9a-f]{32}$/)
    expect(buildInvoicePortalPartition({ siteId: 'solov', userId: 7 })).toBe(partition)
    expect(buildInvoicePortalPartition({ siteId: 'solov', userId: 8 })).not.toBe(partition)
    expect(buildInvoicePortalPartition({ siteId: 'solov-api', userId: 7 })).not.toBe(partition)
  })
})

describe('sameInvoicePortalIdentity', () => {
  it('compares site and user, and treats two empty identities as the same', () => {
    expect(sameInvoicePortalIdentity(xmAccount, { siteId: 'solov', userId: 7 })).toBe(true)
    expect(sameInvoicePortalIdentity(xmAccount, { siteId: 'solov-api', userId: 7 })).toBe(false)
    expect(sameInvoicePortalIdentity(xmAccount, null)).toBe(false)
    expect(sameInvoicePortalIdentity(null, null)).toBe(true)
  })
})

describe('isAllowedInvoicePortalNavigation', () => {
  it('allows only the exact https portal origin', () => {
    expect(isAllowedInvoicePortalNavigation(`${xmOrigin}/orders?page=2`, xmOrigin)).toBe(true)
    expect(isAllowedInvoicePortalNavigation(`${xmOrigin}/login`, xmOrigin)).toBe(true)
    expect(isAllowedInvoicePortalNavigation('http://invoice-xm.solov.cc/orders', xmOrigin)).toBe(false)
    expect(isAllowedInvoicePortalNavigation('https://invoice-xm.solov.cc.evil.example/orders', xmOrigin)).toBe(false)
    expect(isAllowedInvoicePortalNavigation('https://user:pass@invoice-xm.solov.cc/orders', xmOrigin)).toBe(false)
    expect(isAllowedInvoicePortalNavigation('https://xm.solov.cc/console', xmOrigin)).toBe(false)
    expect(isAllowedInvoicePortalNavigation('javascript:alert(1)', xmOrigin)).toBe(false)
    expect(isAllowedInvoicePortalNavigation('not a url', xmOrigin)).toBe(false)
  })
})

describe('isAcceptableInvoiceDownload', () => {
  const blobUrl = `blob:${xmOrigin}/7d3f2c4e-0000-4000-8000-000000000000`

  it('accepts an invoice file the portal page itself hands over', () => {
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'application/pdf', totalBytes: 1024 }, xmOrigin)).toBe(true)
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'image/png', totalBytes: 1024 }, xmOrigin)).toBe(true)
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'IMAGE/JPEG; charset=binary', totalBytes: 1024 }, xmOrigin)).toBe(true)
    // Unknown type or size is decided later by the file's own leading bytes and the bounded read.
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: '', totalBytes: 0 }, xmOrigin)).toBe(true)
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'application/pdf', totalBytes: invoiceDocumentMaxBytes }, xmOrigin)).toBe(true)
  })

  it('refuses anything that is not a small invoice file from the portal page', () => {
    expect(isAcceptableInvoiceDownload({ url: `${xmOrigin}/files/a.pdf`, mimeType: 'application/pdf', totalBytes: 1 }, xmOrigin)).toBe(false)
    expect(isAcceptableInvoiceDownload({ url: 'blob:https://evil.example/abc', mimeType: 'application/pdf', totalBytes: 1 }, xmOrigin)).toBe(false)
    expect(isAcceptableInvoiceDownload({ url: `blob:${xmOrigin}.evil.example/abc`, mimeType: 'application/pdf', totalBytes: 1 }, xmOrigin)).toBe(false)
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'application/x-msdownload', totalBytes: 1 }, xmOrigin)).toBe(false)
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'text/html', totalBytes: 1 }, xmOrigin)).toBe(false)
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'application/pdf', totalBytes: invoiceDocumentMaxBytes + 1 }, xmOrigin)).toBe(false)
    expect(isAcceptableInvoiceDownload({ url: blobUrl, mimeType: 'application/pdf', totalBytes: -1 }, xmOrigin)).toBe(false)
  })
})

describe('resolveInvoiceDocumentType', () => {
  it('recognises PDF, PNG and JPEG by their leading bytes only', () => {
    expect(resolveInvoiceDocumentType(pdfBytes)).toBe('pdf')
    expect(resolveInvoiceDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png')
    expect(resolveInvoiceDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(resolveInvoiceDocumentType(Buffer.from('<html><body>login</body></html>'))).toBeNull()
    expect(resolveInvoiceDocumentType(Buffer.from('MZ\x90\x00'))).toBeNull()
    expect(resolveInvoiceDocumentType(Buffer.alloc(0))).toBeNull()
  })
})

describe('buildInvoiceSaveName', () => {
  it('keeps the portal name but lets the detected type pick the extension', () => {
    expect(buildInvoiceSaveName('invoice-0b4c-11ef.pdf', 'pdf')).toBe('invoice-0b4c-11ef.pdf')
    expect(buildInvoiceSaveName('invoice-0b4c.pdf', 'jpeg')).toBe('invoice-0b4c.jpg')
    expect(buildInvoiceSaveName('invoice-0b4c.exe', 'png')).toBe('invoice-0b4c.png')
  })

  it('drops folders and unsafe characters from the suggested name', () => {
    expect(buildInvoiceSaveName('../../Startup/run.bat', 'pdf')).toBe('run.pdf')
    expect(buildInvoiceSaveName('..\\..\\evil.pdf', 'pdf')).toBe('evil.pdf')
    expect(buildInvoiceSaveName('发票.pdf', 'pdf')).toBe('invoice.pdf')
    expect(buildInvoiceSaveName('', 'png')).toBe('invoice.png')
    expect(buildInvoiceSaveName('...pdf', 'pdf')).toBe('invoice.pdf')
  })
})

describe('createInvoicePortalWindowController', () => {
  it('opens the account portal in an isolated window with no bridge and a fixed title', async () => {
    const harness = createHarness({ iconPath: '/app/icon.png' })
    harness.controller.setAccount(xmAccount)

    await harness.controller.open(xmAccount)

    const windowOptions = (harness.createWindow.mock.calls[0] as unknown as [Electron.BrowserWindowConstructorOptions])[0]
    expect(windowOptions.title).toBe(invoicePortalWindowTitle)
    expect(windowOptions.icon).toBe('/app/icon.png')
    expect(windowOptions.parent).toBeUndefined()
    expect(windowOptions.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: buildInvoicePortalPartition(xmAccount),
    })
    expect(windowOptions.webPreferences?.preload).toBeUndefined()
    expect(harness.window.loadURL).toHaveBeenCalledWith(`${xmOrigin}/orders`)
    expect(harness.window.show).toHaveBeenCalled()
    expect(harness.controller.isOpen()).toBe(true)

    const permission = vi.fn()
    harness.session.setPermissionRequestHandler.mock.calls[0]![0](null, 'media', permission)
    expect(permission).toHaveBeenCalledWith(false)
    expect(harness.session.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false)
    expect(harness.session.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false)

    const titleEvent = { preventDefault: vi.fn() }
    harness.windowEvents.get('page-title-updated')!(titleEvent, '登录 - 开票')
    expect(titleEvent.preventDefault).toHaveBeenCalled()
    expect(harness.window.setTitle).toHaveBeenCalledWith(invoicePortalWindowTitle)
  })

  it('keeps the window on the portal origin and never opens another window', async () => {
    const harness = createHarness()
    await harness.controller.open(xmAccount)

    const inside = { preventDefault: vi.fn() }
    harness.webContentsEvents.get('will-navigate')!(inside, `${xmOrigin}/login`)
    expect(inside.preventDefault).not.toHaveBeenCalled()

    const away = { preventDefault: vi.fn() }
    harness.webContentsEvents.get('will-navigate')!(away, 'https://invoice-xm.solov.cc.evil.example/login')
    expect(away.preventDefault).toHaveBeenCalled()
    const redirect = { preventDefault: vi.fn() }
    harness.webContentsEvents.get('will-redirect')!(redirect, 'http://invoice-xm.solov.cc/orders')
    expect(redirect.preventDefault).toHaveBeenCalled()
    expect(harness.onBlockedNavigation).toHaveBeenCalledTimes(2)

    const openHandler = harness.webContents.setWindowOpenHandler.mock.calls[0]![0]
    expect(openHandler({ url: `${xmOrigin}/orders` })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'https://evil.example/' })).toEqual({ action: 'deny' })
  })

  it('refuses a site without an invoice portal and an account other than the signed-in one', async () => {
    const harness = createHarness()
    await expect(harness.controller.open({ siteId: 'solov-evil', userId: 7 })).rejects.toThrow(invoicePortalOpenFailedMessage)
    harness.controller.setAccount(xmAccount)
    await expect(harness.controller.open({ siteId: 'solov', userId: 8 })).rejects.toThrow(invoicePortalOpenFailedMessage)
    expect(harness.createWindow).not.toHaveBeenCalled()
  })

  it('brings the open window forward instead of reloading it', async () => {
    const harness = createHarness()
    await harness.controller.open(xmAccount)
    harness.window.focus.mockClear()

    await harness.controller.open(xmAccount)

    expect(harness.createWindow).toHaveBeenCalledTimes(1)
    expect(harness.window.loadURL).toHaveBeenCalledTimes(1)
    expect(harness.window.focus).toHaveBeenCalled()
  })

  it('closes the window and says the approved line when the portal does not load', async () => {
    const harness = createHarness({ loadError: Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED'), { code: 'ERR_NAME_NOT_RESOLVED' }) })

    await expect(harness.controller.open(xmAccount)).rejects.toThrow(invoicePortalOpenFailedMessage)

    expect(harness.window.destroy).toHaveBeenCalled()
    expect(harness.controller.isOpen()).toBe(false)
  })

  // 代理 PX-2（同付款窗口）：星芒替客户改了直连只改默认会话，开票窗口的分区要自己照着改，不然走回关掉的代理。
  it('connects the portal session directly before loading when the app has bypassed a dead proxy', async () => {
    const harness = createHarness({ proxyMode: () => 'direct' })
    await harness.controller.open(xmAccount)

    expect(harness.session.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'direct' })
    expect(harness.window.loadURL).toHaveBeenCalledOnce()
    expect(harness.session.setProxy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.window.loadURL.mock.invocationCallOrder[0]!,
    )
    // Only the connection mode changes; the window keeps denying everything else.
    const permission = vi.fn()
    harness.session.setPermissionRequestHandler.mock.calls[0]![0](null, 'media', permission)
    expect(permission).toHaveBeenCalledWith(false)
    const away = { preventDefault: vi.fn() }
    harness.webContentsEvents.get('will-navigate')!(away, 'https://evil.example/')
    expect(away.preventDefault).toHaveBeenCalledOnce()
    const openHandler = harness.webContents.setWindowOpenHandler.mock.calls[0]![0]
    expect(openHandler({ url: `${xmOrigin}/orders` })).toEqual({ action: 'deny' })
  })

  it('follows the system proxy by default and resets the persistent session for every new window', async () => {
    const fallback = createHarness()
    await fallback.controller.open(xmAccount)
    expect(fallback.session.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'system' })

    // Both windows of one account share the persistent session, so the mode
    // the first one set would stick unless every new window sets it again.
    const first = createHarness()
    const second = createHarness()
    second.webContents.session = first.session
    let mode: 'direct' | 'system' = 'direct'
    const controller = createInvoicePortalWindowController({
      temporaryDirectory: () => path.join(scratch, 'invoice-downloads'),
      downloadsDirectory: () => path.join(scratch, 'Downloads'),
      createWindow: vi.fn().mockReturnValueOnce(first.window).mockReturnValueOnce(second.window),
      sessionFromPartition: vi.fn(() => first.session as never),
      proxyMode: () => mode,
    })
    await controller.open(xmAccount)
    // The customer closes the window; the proxy software comes back and the
    // app returns to the system proxy before the next open.
    first.window.destroy()
    mode = 'system'
    await controller.open(xmAccount)
    expect(first.session.setProxy.mock.calls).toEqual([[{ mode: 'direct' }], [{ mode: 'system' }]])
    expect(second.window.loadURL).toHaveBeenCalledOnce()
    controller.destroy()
  })

  it('still opens the portal when the connection mode cannot be applied', async () => {
    const harness = createHarness({ proxyMode: () => 'direct' })
    harness.session.setProxy.mockRejectedValueOnce(new Error('setProxy failed'))

    await harness.controller.open(xmAccount)

    expect(harness.window.loadURL).toHaveBeenCalledOnce()
    expect(harness.controller.isOpen()).toBe(true)
  })

  it('never loads a window that was closed while its connection mode was being applied', async () => {
    for (const close of [
      (controller: ReturnType<typeof createHarness>['controller']) => controller.setAccount({ siteId: 'solov-api', userId: 9 }),
      (controller: ReturnType<typeof createHarness>['controller']) => controller.destroy(),
    ]) {
      let applied = () => {}
      const harness = createHarness({ proxyMode: () => 'direct' })
      harness.session.setProxy.mockReturnValueOnce(new Promise<undefined>((resolve) => { applied = () => resolve(undefined) }))
      harness.controller.setAccount(xmAccount)
      const opening = harness.controller.open(xmAccount)
      const rejected = expect(opening).rejects.toThrow(invoicePortalOpenFailedMessage)
      // Switching accounts, signing out or quitting closes the window before the page starts.
      close(harness.controller)
      applied()
      await rejected

      expect(harness.window.loadURL).not.toHaveBeenCalled()
      expect(harness.window.destroy).toHaveBeenCalledOnce()
      expect(harness.controller.isOpen()).toBe(false)
    }
  })

  it('closes the window and clears the previous login when the account changes or signs out', async () => {
    const harness = createHarness()
    harness.controller.setAccount(xmAccount)
    await harness.controller.open(xmAccount)

    // A token refresh reports the same person again: nothing is cleared.
    harness.controller.setAccount({ siteId: 'solov', userId: 7 })
    expect(harness.window.destroy).not.toHaveBeenCalled()
    expect(harness.sessionFromPartition).not.toHaveBeenCalled()

    harness.controller.setAccount({ siteId: 'solov-api', userId: 9 })
    expect(harness.window.destroy).toHaveBeenCalled()
    expect(harness.controller.isOpen()).toBe(false)
    expect(harness.sessionFromPartition).toHaveBeenCalledWith(buildInvoicePortalPartition(xmAccount))
    expect(harness.session.clearStorageData).toHaveBeenCalledTimes(1)
    expect(harness.session.clearCache).toHaveBeenCalledTimes(1)

    harness.controller.setAccount(null)
    expect(harness.sessionFromPartition).toHaveBeenLastCalledWith(buildInvoicePortalPartition({ siteId: 'solov-api', userId: 9 }))
    expect(harness.session.clearStorageData).toHaveBeenCalledTimes(2)
  })

  it('saves a downloaded invoice through the save dialog and an atomic write', async () => {
    // The save dialog only ever hands back a folder that exists.
    fs.mkdirSync(path.join(scratch, 'saved'))
    const harness = createHarness()
    await harness.controller.open(xmAccount)

    const download = startDownload(harness, { url: `blob:${xmOrigin}/abc`, filename: 'invoice-0b4c.pdf' })

    expect(download.event.preventDefault).not.toHaveBeenCalled()
    const temporaryPath = download.item.setSavePath.mock.calls[0]![0] as string
    expect(path.dirname(temporaryPath)).toBe(path.join(scratch, 'invoice-downloads'))
    fs.writeFileSync(temporaryPath, pdfBytes)
    download.events.get('done')!({}, 'completed')

    await vi.waitFor(() => expect(harness.onEvent).toHaveBeenCalledWith({ kind: 'download.saved', type: 'pdf', bytes: pdfBytes.length }))
    expect(harness.showSaveDialog).toHaveBeenCalledWith(harness.window, {
      title: invoiceSaveDialogTitle,
      defaultPath: path.join(scratch, 'Downloads', 'invoice-0b4c.pdf'),
    })
    expect(fs.readFileSync(path.join(scratch, 'saved', 'my-invoice.pdf'))).toEqual(pdfBytes)
    expect(fs.existsSync(temporaryPath)).toBe(false)
    expect(harness.showMessageBox).not.toHaveBeenCalled()
  })

  it('writes nothing when the customer cancels the save dialog', async () => {
    const harness = createHarness({ showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })) })
    await harness.controller.open(xmAccount)

    const download = startDownload(harness, { url: `blob:${xmOrigin}/abc` })
    const temporaryPath = download.item.setSavePath.mock.calls[0]![0] as string
    fs.writeFileSync(temporaryPath, pdfBytes)
    download.events.get('done')!({}, 'completed')

    await vi.waitFor(() => expect(fs.existsSync(temporaryPath)).toBe(false))
    expect(fs.existsSync(path.join(scratch, 'saved'))).toBe(false)
    expect(harness.showMessageBox).not.toHaveBeenCalled()
  })

  it('refuses a downloaded file that is not an invoice and says the approved line', async () => {
    const harness = createHarness()
    await harness.controller.open(xmAccount)

    const download = startDownload(harness, { url: `blob:${xmOrigin}/abc`, mimeType: '' })
    const temporaryPath = download.item.setSavePath.mock.calls[0]![0] as string
    fs.writeFileSync(temporaryPath, '<html>not an invoice</html>')
    download.events.get('done')!({}, 'completed')

    await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalled())
    expect(harness.showSaveDialog).not.toHaveBeenCalled()
    expect(fs.existsSync(temporaryPath)).toBe(false)
    expect(harness.showMessageBox).toHaveBeenCalledWith(harness.window, expect.objectContaining({
      message: invoiceSaveFailedMessage,
      buttons: [invoiceSaveFailedButton],
    }))
    expect(harness.onEvent).toHaveBeenCalledWith({ kind: 'download.rejected' })
  })

  it('cancels downloads that are not the portal page handing over an invoice', async () => {
    const harness = createHarness()
    await harness.controller.open(xmAccount)

    const direct = startDownload(harness, { url: 'https://evil.example/invoice.exe', mimeType: 'application/x-msdownload' })
    expect(direct.event.preventDefault).toHaveBeenCalled()
    expect(direct.item.setSavePath).not.toHaveBeenCalled()
    expect(harness.showMessageBox).toHaveBeenCalledTimes(1)

    const elsewhere = startDownload(harness, { url: `blob:${xmOrigin}/abc` }, { other: true })
    expect(elsewhere.event.preventDefault).toHaveBeenCalled()
    expect(elsewhere.item.setSavePath).not.toHaveBeenCalled()
  })

  it('says the approved line when the download itself breaks off', async () => {
    const harness = createHarness()
    await harness.controller.open(xmAccount)

    const download = startDownload(harness, { url: `blob:${xmOrigin}/abc` })
    download.events.get('done')!({}, 'interrupted')

    expect(harness.showMessageBox).toHaveBeenCalledWith(harness.window, expect.objectContaining({ message: invoiceSaveFailedMessage }))
    expect(harness.onEvent).toHaveBeenCalledWith({ kind: 'download.failed', code: 'INTERRUPTED' })
  })

  it('says the approved line when the chosen place cannot be written', async () => {
    // The chosen folder is really a file, so nothing can be written under it.
    const blocked = path.join(scratch, 'blocked')
    fs.writeFileSync(blocked, 'a file, not a folder')
    const harness = createHarness({ showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: path.join(blocked, 'invoice.pdf') })) })
    await harness.controller.open(xmAccount)

    const download = startDownload(harness, { url: `blob:${xmOrigin}/abc` })
    fs.writeFileSync(download.item.setSavePath.mock.calls[0]![0] as string, pdfBytes)
    download.events.get('done')!({}, 'completed')

    await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalled())
    expect(harness.showMessageBox).toHaveBeenCalledWith(harness.window, expect.objectContaining({ message: invoiceSaveFailedMessage }))
    expect(fs.readFileSync(blocked, 'utf8')).toBe('a file, not a folder')
    expect(harness.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'download.failed' }))
  })
})
