import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button, Dialog, Notice, useToast } from '../../ui'
import { markRestartPending, useRestartPending } from './restart-reminder'
import { errorMessage, pendingBusinessOperations } from '../../business-common'

/**
 * Node.js 装完 Windows 要求重启（MSI 退出码 3010）时弹的框，首页与检查页
 * 共用；Codex 桌面端打不开时错误框里的「立即重启」也弹它（reason）。只给一颗「现在重启」，不让用户在「稍后 / 现在」之间做选择（yoyo 2026-09-22：
 * 面向小白，少让他做决定）；关掉这个框就是稍后自己重启。
 *
 * 打开时焦点落在说明文字上而不是按钮上：重启会关掉用户手上所有程序，不能让一次
 * 回车就触发。
 *
 * 重启走主进程已有的 runtime:restart-windows（shutdown /r /t 15）。发出去之前两道
 * 闸：这里查渲染层还有没有没做完的业务操作（保存配置之类），主进程那侧查安装队列；
 * 任一处拦下都留在框里说明原因，不关框。
 */
export function RuntimeRestartDialog({ onClose, restart, reason = 'runtime' }: {
  onClose: () => void
  restart: () => Promise<void>
  /**
   * 为什么要重启；缺省 = Node.js 装完（旧行为）。'codexDesktop' 是 Codex 桌面端打不开时错误框里那颗
   * 「立即重启」：同一次重启、同样两道闸，只是换了字，也不挂页顶那条「运行环境需重启」的提醒。
   */
  reason?: 'runtime' | 'codexDesktop'
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const intro = useRef<HTMLDivElement>(null)
  // 框一弹出来就记下「还差重启」，关掉框之后页顶那条提醒接着挂。
  useEffect(() => { if (reason === 'runtime') markRestartPending() }, [reason])
  function now() {
    if (busy) return
    if (pendingBusinessOperations().length > 0) {
      setError('有操作尚未完成，请等待完成后再重启电脑。')
      return
    }
    setBusy(true)
    setError('')
    void restart().then(() => {
      onClose()
      toast.show('电脑将在约 15 秒后重启。', 'warn')
    }, (cause) => {
      setBusy(false)
      setError(errorMessage(cause, '重启指令发送失败，请手动重启电脑。'))
    })
  }
  return <Dialog
    open
    title={reason === 'codexDesktop' ? '重启电脑' : 'Node.js 已安装，重启电脑后生效'}
    onClose={onClose}
    busy={busy}
    initialFocus={intro}
    testId="runtime-restart-dialog"
    footer={<Button variant="primary" icon={RotateCcw} loading={busy} onClick={now} testId="runtime-restart-now">立即重启</Button>}
  >
    {/* Codex 那段字 yoyo 2026-11-21 批的（「重启框改」）。 */}
    <div ref={intro} tabIndex={-1}>{reason === 'codexDesktop'
      ? <p>点击「立即重启」后，电脑将在约 15 秒后重启，请先保存未保存的文件。重启后请打开星芒，再次点击 Codex 桌面端的「打开」。</p>
      : <>
        <p>Windows 需重启后才能完成 Node.js 安装，重启前安装命令行工具可能失败。</p>
        <p>点击「立即重启」后，电脑将在约 15 秒后重启，请先保存未保存的文件。如暂不重启，可关闭此窗口，稍后手动重启。</p>
      </>}
    </div>
    {error && <p className="v2-business-notice is-error" role="alert" data-testid="runtime-restart-error">{error}</p>}
  </Dialog>
}

/**
 * 关掉重启框之后挂在页顶的那一条：软件开着就一直在，点「现在重启」再弹一次同一个框，
 * 走同样的两道闸。没记下「还差重启」时什么都不画。
 */
export function RestartReminder({ restart }: { restart: () => Promise<void> }) {
  const pending = useRestartPending()
  const [open, setOpen] = useState(false)
  if (!pending) return null
  return <>
    <div className="v2-restart-reminder"><Notice tone="warn" icon={RotateCcw} title="需要重启电脑"
      body="运行环境需重启电脑后才能完成安装，重启前安装工具可能失败。"
      actions={<Button size="sm" icon={RotateCcw} onClick={() => setOpen(true)} testId="restart-reminder-now">立即重启</Button>}
      testId="restart-reminder" /></div>
    {open && <RuntimeRestartDialog onClose={() => setOpen(false)} restart={restart} />}
  </>
}
