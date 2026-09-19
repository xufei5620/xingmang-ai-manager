import { useState } from 'react'
import { Copy } from 'lucide-react'
import type { PlatformCapabilities } from '../../../../electron/ipc-contract'
import { Button, Dialog } from '../../ui'

export interface ManualUninstallState {
  /** Display name of the tool, so the dialog can name it without a lookup. */
  name: string
  reason: string
  manualCommand: string | null
}

/**
 * The backend text promises "下方是可直接复制执行的清理命令", so the shell the
 * command is meant for has to be named the same way the maintenance page names
 * it — a PowerShell line pasted into cmd.exe silently does the wrong thing.
 */
export function manualShellLabel(platform: PlatformCapabilities['platform'] | undefined): string {
  return platform === 'macos' || platform === 'linux' ? '终端' : '普通 PowerShell'
}

export function ManualUninstallDialog({ state, platform, onClose }: {
  state: ManualUninstallState
  platform: PlatformCapabilities['platform'] | undefined
  onClose(): void
}) {
  const [copied, setCopied] = useState(false)
  const shell = manualShellLabel(platform)
  return <Dialog open title={`${state.name} 需要手动清理`} width={640} onClose={onClose} testId="manual-uninstall"
    footer={<Button onClick={onClose}>知道了</Button>}>
    <p role="alert" data-testid="manual-uninstall-reason">{state.reason}</p>
    {state.manualCommand ? <>
      <p>在{shell}里执行下面这条命令即可完成清理。</p>
      <pre className="v2-business-code" data-testid="manual-uninstall-command">{state.manualCommand}</pre>
      <Button size="sm" icon={Copy} testId="manual-uninstall-copy" onClick={() => {
        void navigator.clipboard.writeText(state.manualCommand ?? '').then(() => setCopied(true)).catch(() => setCopied(false))
      }}>复制命令</Button>
      {copied && <span role="status">命令已复制</span>}
    </> : <p>这次没有生成可复制的命令：本次检查本身没有通过，照着一条未经复核的命令删文件并不安全。请联系客服协助处理。</p>}
  </Dialog>
}
