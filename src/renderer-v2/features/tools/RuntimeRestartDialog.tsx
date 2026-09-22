import { useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button, Dialog, useToast } from '../../ui'
import { errorMessage, pendingBusinessOperations } from '../../business-common'

/**
 * Node.js 装完 Windows 要求重启（MSI 退出码 3010）时弹的框，首页与「安装卸载」页
 * 共用。只给一颗「现在重启」，不让用户在「稍后 / 现在」之间做选择（yoyo 2026-09-22：
 * 面向小白，少让他做决定）；关掉这个框就是稍后自己重启。
 *
 * 打开时焦点落在说明文字上而不是按钮上：重启会关掉用户手上所有程序，不能让一次
 * 回车就触发。
 *
 * 重启走主进程已有的 runtime:restart-windows（shutdown /r /t 15）。发出去之前两道
 * 闸：这里查渲染层还有没有没做完的业务操作（保存配置之类），主进程那侧查安装队列；
 * 任一处拦下都留在框里说明原因，不关框。
 */
export function RuntimeRestartDialog({ onClose, restart }: { onClose: () => void; restart: () => Promise<void> }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const intro = useRef<HTMLDivElement>(null)
  function now() {
    if (busy) return
    if (pendingBusinessOperations().length > 0) {
      setError('还有操作没做完，等它做完再重启电脑。')
      return
    }
    setBusy(true)
    setError('')
    void restart().then(() => {
      onClose()
      toast.show('电脑大约 15 秒后重启。', 'warn')
    }, (cause) => {
      setBusy(false)
      setError(errorMessage(cause, '重启没有发出去，请自己重启一次电脑。'))
    })
  }
  return <Dialog
    open
    title="Node.js 装好了，重启电脑后就能用"
    onClose={onClose}
    busy={busy}
    initialFocus={intro}
    testId="runtime-restart-dialog"
    footer={<Button variant="primary" icon={RotateCcw} loading={busy} onClick={now} testId="runtime-restart-now">现在重启</Button>}
  >
    <div ref={intro} tabIndex={-1}>
      <p>Windows 要重启一次才算把 Node.js 装完，重启之前装命令行工具可能会失败。</p>
      <p>点「现在重启」后电脑大约 15 秒后重启，请先保存手上没保存的文件。不想现在重启就关掉这个框，之后自己重启一次也行。</p>
    </div>
    {error && <p className="v2-business-notice is-error" role="alert" data-testid="runtime-restart-error">{error}</p>}
  </Dialog>
}
