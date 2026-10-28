export const canvasExpectedAccountHeader = 'X-Canvas-Expected-Account'
export const canvasAccountStatusHeader = 'X-Canvas-Account-Status'
export const canvasAccountChangedCode = 'ACCOUNT_CHANGED'
export const canvasAccountChangedMessage = '当前账户已变化，请重新进入工作区；当前编辑内容仍保留。'

export function isCanvasPublicAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export class CanvasAccountChangedError extends Error {
  readonly code = canvasAccountChangedCode
  readonly status = 409

  constructor() {
    super(canvasAccountChangedMessage)
    this.name = 'CanvasAccountChangedError'
  }
}
