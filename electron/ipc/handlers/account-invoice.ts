// 主窗口业务通道的处理器：「我的订单」里直接开发票（invoice-center-client.ts）。开票系统是哪个、以谁的身份去，
// 都由开票客户端按当前登录定；这里只解析入参（I5）、把结果交回去。桌面令牌和账号凭据不出主进程（I3）。
import { BrowserWindow, dialog } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { invoiceCenterNoReason, type InvoiceCenterClient } from '../../invoice-center-client'
import { saveInvoiceDocument } from '../../invoice-document-save'
import { writeAtomicSafeBinaryFile } from '../../safe-local-data'
import {
  parseInvoiceDocumentRequestId,
  parseInvoiceProfileSaveInput,
  parseInvoiceRequestsQuery,
  parseInvoiceSubmitInput,
  parseInvoiceWithdrawInput,
} from '../parsers/account-invoice'
import type { IpcHandlerContext } from './context'

export function registerAccountInvoiceHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler } = ctx
  function invoiceCenter(): InvoiceCenterClient {
    // 没接上开票客户端（测试、或者这个版本没开票）：界面按读不到处理，跟开票系统没给原因一样。
    if (!options.invoiceCenter) throw new Error(invoiceCenterNoReason)
    return options.invoiceCenter
  }
  function downloadsDirectory(): string {
    try {
      if (options.downloadsDirectory) return options.downloadsDirectory()
    } catch {
      // app.getPath 拿不到「下载」时退到主目录下的 Downloads，保存框里客户还能自己换。
    }
    return path.join(os.homedir(), 'Downloads')
  }
  // 一律 async：入参不对时界面收到的是拒绝的 Promise，跟开票系统报错走同一条路。
  registerTrustedHandler('account:list-invoice-orders', async () => invoiceCenter().listOrders())
  registerTrustedHandler('account:list-invoice-profiles', async () => invoiceCenter().listProfiles())
  registerTrustedHandler('account:list-invoice-requests', async (_event, query: unknown) => (
    invoiceCenter().listRequests(parseInvoiceRequestsQuery(query))
  ))
  registerTrustedHandler('account:save-invoice-profile', async (_event, input: unknown) => (
    invoiceCenter().saveProfile(parseInvoiceProfileSaveInput(input))
  ))
  registerTrustedHandler('account:submit-invoice-request', async (_event, input: unknown) => (
    invoiceCenter().submitRequest(parseInvoiceSubmitInput(input))
  ))
  registerTrustedHandler('account:withdraw-invoice-request', async (_event, input: unknown) => (
    invoiceCenter().withdrawRequest(parseInvoiceWithdrawInput(input))
  ))
  registerTrustedHandler('account:save-invoice-document', async (event, requestId: unknown) => {
    const parsed = parseInvoiceDocumentRequestId(requestId)
    const center = invoiceCenter()
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return saveInvoiceDocument(parsed, {
      download: (id) => center.downloadDocument(id),
      downloadsDirectory,
      showSaveDialog: (dialogOptions) => (parent ? dialog.showSaveDialog(parent, dialogOptions) : dialog.showSaveDialog(dialogOptions)),
      showFailure: async (message, button) => {
        const boxOptions = { type: 'error' as const, message, buttons: [button], defaultId: 0, cancelId: 0, noLink: true }
        if (parent) await dialog.showMessageBox(parent, boxOptions)
        else await dialog.showMessageBox(boxOptions)
      },
      write: (filePath, bytes) => writeAtomicSafeBinaryFile(filePath, bytes, '发票文件'),
      onEvent: (saveEvent) => {
        if (saveEvent.kind === 'saved') options.runtimeLog.log('info', 'invoice', 'download.saved', '发票已另存', { type: saveEvent.type, bytes: saveEvent.bytes })
        else options.runtimeLog.log('warn', 'invoice', 'download.failed', '发票没能另存', { code: saveEvent.code })
      },
    })
  })
}
