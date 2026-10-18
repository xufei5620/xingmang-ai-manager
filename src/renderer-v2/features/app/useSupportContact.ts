import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import QRCode from 'qrcode'
import type { AccountSessionState, PlatformCapabilities } from '../../../../electron/ipc-contract'
import { resolveSupportServiceUrl } from '../../../../electron/relay-sites'
import type { FeedbackSupport } from '../../pages-maintenance'
import { supportQrFallbackText } from './fallback-messages'
import { supportFailureOf, type OperationFailure } from './OperationErrorDialog'
import { buildLastFailureLine, buildSupportIdentityLine, linuxSystemDetail, type SupportFailure } from './SupportIdentity'
import type { WindowOs } from './window-os'
import type { AppApi, AppToast, Perform } from './runtime-context'

interface SupportContactOptions {
  app: AppApi
  session: AccountSessionState
  version: string | undefined
  os: WindowOs
  platform: PlatformCapabilities | null
  systemLabel: string | undefined
  operationError: OperationFailure | null
  lastFailure: SupportFailure | null
  setLastFailure: Dispatch<SetStateAction<SupportFailure | null>>
  perform: Perform
  toast: AppToast
}

/** 找客服要用的那几样：微信二维码、发给客服的那行身份、最近一次出错。帮助弹窗和反馈与客服页说的是同一份。 */
export function useSupportContact({ app, session, version, os, platform, systemLabel, operationError, lastFailure, setLastFailure, perform, toast }: SupportContactOptions) {
  const [supportQr, setSupportQr] = useState<{ url: string; data: string | null }>()
  const supportUrl = resolveSupportServiceUrl(session)
  const qr = supportQr?.url === supportUrl ? supportQr.data ?? undefined : undefined
  const qrFallback = supportQrFallbackText(supportQr, supportUrl)
  const supportInput = { signedIn: session.authenticated, account: session.account, version, os,
    ...(os === 'linux' ? { systemDetail: linuxSystemDetail(systemLabel, platform?.architecture) } : {}) }
  const supportIdentity = buildSupportIdentityLine(supportInput)
  const lastFailureLine = lastFailure ? buildLastFailureLine(lastFailure) : undefined
  // 弹过的错误框都记成「最近一次出错」，关掉以后再找客服也带得上。
  useEffect(() => { if (operationError) setLastFailure(supportFailureOf(operationError, new Date())) }, [operationError, setLastFailure])
  useEffect(() => {
    let current = true
    void QRCode.toDataURL(supportUrl, { width: 192, margin: 1, errorCorrectionLevel: 'M' })
      .then((data) => { if (current) setSupportQr({ url: supportUrl, data }) })
      .catch(() => { if (current) setSupportQr({ url: supportUrl, data: null }) })
    return () => { current = false }
  }, [supportUrl])
  // 帮助弹窗和反馈与客服页「找客服」卡上的同一行身份，复制时连同最近一次出错一起带走。
  const copySupportIdentity = () => {
    void navigator.clipboard.writeText(lastFailureLine ? `${supportIdentity}\n${lastFailureLine}` : supportIdentity)
      .then(() => toast.show('已复制，发给客服就行', 'ok'), () => toast.show('没复制上，请手动选中这行文字复制。', 'warn'))
  }
  const openSupport = () => void perform('打开帮助', () => app.openExternal(supportUrl))
  const feedbackSupport: FeedbackSupport = { qr, qrFallback, identity: supportIdentity, lastFailure: lastFailureLine, open: openSupport, copyIdentity: copySupportIdentity }
  return { qr, qrFallback, supportInput, supportIdentity, lastFailureLine, copySupportIdentity, openSupport, feedbackSupport }
}
