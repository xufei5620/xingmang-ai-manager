import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { ExternalDeepLink, XingmangApi } from '../../../../electron/ipc-contract'
import type { PageId } from '../../registry/pages'
import type { AuthMode } from '../auth'
import type { ToolId } from '../tools/model'
import { deepLinkReadErrorText } from './fallback-messages'
import type { OperationFailure } from './OperationErrorDialog'

interface DeepLinkOptions {
  native: XingmangApi
  mounted: RefObject<boolean>
  boot: 'loading' | 'ready' | 'failed'
  authenticated: boolean
  /** 这几样开着时先不处理链接，等它们关了再说。 */
  auth: AuthMode | null
  configTool: ToolId | null
  confirmation: unknown
  switcher: boolean
  restartDialog: boolean
  navigate(page: PageId, section?: string): void
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
  setOperationError: Dispatch<SetStateAction<OperationFailure | null>>
  setPaymentReturn: Dispatch<SetStateAction<{ sequence: number; order: string | null } | undefined>>
}

/** 从浏览器点回来的链接：邀请码去注册，付款回来去「我的订单」，坏链接说一句。 */
export function useDeepLinks({ native, mounted, boot, authenticated, auth, configTool, confirmation, switcher, restartDialog, navigate, setAuth, setOperationError, setPaymentReturn }: DeepLinkOptions) {
  const [pendingLink, setPendingLink] = useState<ExternalDeepLink | null>(null)
  const [inviteCode, setInviteCode] = useState('')
  const linkPrompted = useRef(false)
  useEffect(() => {
    function receive() {
      void native.takeExternalDeepLink()
        .then((link) => { if (link && mounted.current) { linkPrompted.current = false; setPendingLink(link) } })
        .catch((cause) => { if (mounted.current) setOperationError({ message: deepLinkReadErrorText(cause), retry: receive }) })
    }
    const unsubscribe = native.onExternalDeepLink(receive)
    receive()
    return unsubscribe
  }, [native, mounted, setOperationError])
  useEffect(() => {
    if (!pendingLink || boot !== 'ready' || auth || configTool || confirmation || switcher || restartDialog) return
    if (pendingLink.kind === 'invalid') { setOperationError({ message: pendingLink.message }); setPendingLink(null) }
    else if (pendingLink.kind === 'invite') {
      if (authenticated) setOperationError({ message: `邀请码为 ${pendingLink.code}。退出当前账号后可用于注册。` })
      else { setInviteCode(pendingLink.code); setAuth('register') }
      setPendingLink(null)
    } else if (authenticated) {
      navigate('account', 'orders')
      setPaymentReturn((current) => ({ sequence: (current?.sequence ?? 0) + 1, order: pendingLink.order }))
      setPendingLink(null)
    } else if (!linkPrompted.current) { linkPrompted.current = true; setAuth('login') }
  }, [pendingLink, boot, auth, configTool, confirmation, switcher, restartDialog, authenticated, navigate, setAuth, setOperationError, setPaymentReturn])
  return { inviteCode }
}
