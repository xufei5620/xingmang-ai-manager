// 微信扫码登录交给界面的样子。契约（ipc-contract.ts）和渲染层只 import type 它，所以这里不许
// import 任何东西（I6，门禁 scripts/verify-renderer-boundary.test.cjs 的 typeImportableOnly）。

export type WeixinLoginPhase =
  | 'waiting-scan'
  | 'scanned'
  | 'need-verify-code'
  | 'verify-code-wrong'
  | 'confirmed'
  | 'failed'
  | 'cancelled'

export interface WeixinLoginSnapshot {
  loginId: string
  phase: WeixinLoginPhase
  /** data:image/png;base64,… 只在换了新二维码时带。 */
  qrImage?: string
  /** 这张二维码什么时候过期（毫秒）。 */
  expiresAt?: number
  /** 能上屏的中文。 */
  message?: string
  /** 界面隔多久再调 poll；0 表示马上。 */
  retryAfterMs: number
}

export interface WeixinLoginPollInput {
  loginId: string
  /** 手机微信上显示的那串数字；只在要输的时候带。 */
  verifyCode?: string
}
