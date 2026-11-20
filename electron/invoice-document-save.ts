// 「开票记录」和「我的订单」里的「下载发票」：主进程从开票系统取发票文件，按开头字节认过类型，再由客户在保存框里
// 选位置、原子写（I8）。界面层只给申请编号，文件内容和保存位置都不经过它。
// 保存框标题和保存失败那句、那个按钮是 0.2.24 开票窗口那次批过的原字，这次照用。
import path from 'node:path'
import { buildInvoiceSaveName, type InvoiceDocument } from './invoice-center-client'
import type { InvoiceDocumentSaveResult } from './invoice-center-types'

export const invoiceSaveDialogTitle = '保存发票'
export const invoiceSaveFailedMessage = '发票没保存下来，请再点一次「下载发票」；还不行请找客服。'
export const invoiceSaveFailedButton = '知道了'

export type InvoiceDocumentSaveEvent =
  | { kind: 'saved'; type: InvoiceDocument['type']; bytes: number }
  | { kind: 'failed'; code: string }

export interface InvoiceDocumentSaveOptions {
  download(requestId: string): Promise<InvoiceDocument>
  downloadsDirectory(): string
  showSaveDialog(options: { title: string; defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>
  /** 保存失败那个提示框（「知道了」）。 */
  showFailure(message: string, button: string): Promise<void>
  write(filePath: string, bytes: Buffer): Promise<void>
  /** 只记类别和错误码：文件名带申请编号，不进日志（I13）。 */
  onEvent?: (event: InvoiceDocumentSaveEvent) => void
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN'
}

/** 取一张发票、问客户存哪、存下来。客户在保存框里点了取消不算失败；别的不管哪一步没成，都弹那句「发票没保存下来」。 */
export async function saveInvoiceDocument(requestId: string, options: InvoiceDocumentSaveOptions): Promise<InvoiceDocumentSaveResult> {
  try {
    const document = await options.download(requestId)
    const result = await options.showSaveDialog({
      title: invoiceSaveDialogTitle,
      defaultPath: path.join(options.downloadsDirectory(), buildInvoiceSaveName(document.suggestedName || `invoice-${requestId}`, document.type)),
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await options.write(result.filePath, document.bytes)
    options.onEvent?.({ kind: 'saved', type: document.type, bytes: document.bytes.length })
    return { saved: true }
  } catch (error) {
    options.onEvent?.({ kind: 'failed', code: errorCode(error) })
    await options.showFailure(invoiceSaveFailedMessage, invoiceSaveFailedButton).catch(() => undefined)
    return { saved: false }
  }
}
