import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { ExternalDeepLink, XingmangApi } from '../../../../electron/ipc-contract'
import type { PageId } from '../../registry/pages'
import type { AuthMode } from '../auth'
import type { ToolId } from '../tools/model'
import { deepLinkReadErrorText } from './fallback-messages'
import type { OperationFailure } from './OperationErrorDialog'
import type { AppToast } from './runtime-context'

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
  toast: AppToast
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
  setOperationError: Dispatch<SetStateAction<OperationFailure | null>>
  setPaymentReturn: Dispatch<SetStateAction<{ sequence: number; order: string | null } | undefined>>
}

/**
 * 已经登录时点开的邀请链接（D69）：只是告诉他邀请码是什么，没有出错，所以是右下角一条普通提示条，
 * 不弹「操作没有完成」报错框，也不带「复制给客服」。提示条带一颗「复制邀请码」，点了才关；
 * 没复制上就留着这条，邀请码就在字里，能手动选中。
 */
export function showSignedInInvite(toast: AppToast, code: string, clipboard: () => Pick<Clipboard, 'writeText'> | undefined) {
  toast.show(`你已经登录了。邀请码 ${code} 要退出当前账号、注册新账号时才能用。`, 'neutral', {
    label: '复制邀请码',
    onSelect(dismiss) {
      // 点的那一刻再取剪贴板：提示条能挂很久，不拿弹出来那一刻的。
      const target = clipboard()
      const copied = target ? target.writeText(code) : Promise.reject(new Error('clipboard unavailable'))
      void copied.then(() => { dismiss(); toast.show('邀请码已复制', 'ok') }, () => toast.show('没复制上，请手动选中这行文字复制。', 'warn'))
    },
  })
}

function readClipboard(): Clipboard | undefined { return navigator.clipboard }

/** 从浏览器点回来的链接：邀请码去注册，付款回来去「我的订单」，坏链接说一句。 */
export function useDeepLinks({ native, mounted, boot, authenticated, auth, configTool, confirmation, switcher, restartDialog, navigate, toast, setAuth, setOperationError, setPaymentReturn }: DeepLinkOptions) {
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
      if (authenticated) showSignedInInvite(toast, pendingLink.code, readClipboard)
      else { setInviteCode(pendingLink.code); setAuth('register') }
      setPendingLink(null)
    } else if (authenticated) {
      navigate('account', 'orders')
      setPaymentReturn((current) => ({ sequence: (current?.sequence ?? 0) + 1, order: pendingLink.order }))
      setPendingLink(null)
    } else if (!linkPrompted.current) { linkPrompted.current = true; setAuth('login') }
  }, [pendingLink, boot, auth, configTool, confirmation, switcher, restartDialog, authenticated, navigate, toast, setAuth, setOperationError, setPaymentReturn])
  return { inviteCode }
}
