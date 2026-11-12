import { useState } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import type { CliLeftoverCleanupResult, PlatformCapabilities, ToolUninstallResult } from '../../../../electron/ipc-contract'
import type { ActiveProviderId } from '../../../../electron/catalog'
import { Button, Dialog, useToast } from '../../ui'
import { errorMessage } from '../../business-common'

export interface ManualUninstallState {
  /** Display name of the tool, so the dialog can name it without a lookup. */
  name: string
  reason: string
  manualCommand: string | null
  /**
   * 主进程记下了命令里的那几个文件、能在核对后替客户删时才有（已知48「帮我清理」）。
   * 只是工具名：删哪些文件永远由主进程自己定。
   */
  cleanUpTool?: ActiveProviderId
}

type ManualHelp = Extract<ToolUninstallResult, { outcome: 'manual-required' }>['manualHelp']

/** 首页工具卡片拿到 manual-required 后弹框用的那几样。 */
export function manualUninstallState(name: string, id: ActiveProviderId | 'codexDesktop', help: ManualHelp): ManualUninstallState {
  const state: ManualUninstallState = { name, reason: help.reason, manualCommand: help.manualCommand }
  if (help.cleanUpAvailable && help.manualCommand && id !== 'codexDesktop') state.cleanUpTool = id
  return state
}

/**
 * The backend text promises "下方是可直接复制执行的清理命令", so the shell the
 * command is meant for has to be named the same way the maintenance page names
 * it — a PowerShell line pasted into cmd.exe silently does the wrong thing.
 */
export function manualShellLabel(platform: PlatformCapabilities['platform'] | undefined): string {
  return platform === 'macos' || platform === 'linux' ? '终端' : '普通 PowerShell'
}

export function ManualUninstallDialog({ state, platform, onClose, cleanUp, onHelp }: {
  state: ManualUninstallState
  platform: PlatformCapabilities['platform'] | undefined
  onClose(): void
  /** 没传就只给命令，和以前一样。 */
  cleanUp?(tool: ActiveProviderId): Promise<CliLeftoverCleanupResult>
  /**
   * 「找客服」：没生成命令、或「帮我清理」没删干净时，框里叫人找客服，就得给个按钮（D21）。
   * 帮助框是后开的模态框，叠在这个框上面，关掉还能回来看原因。没传就不给这颗按钮。
   */
  onHelp?(): void
}) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [problem, setProblem] = useState('')
  const shell = manualShellLabel(platform)
  const tool = state.manualCommand && cleanUp ? state.cleanUpTool : undefined
  function clean() {
    if (!tool || !cleanUp || cleaning) return
    setCleaning(true)
    setProblem('')
    void cleanUp(tool).then((result) => {
      if (result.remaining > 0) {
        setCleaning(false)
        setProblem(`还有 ${result.remaining} 个文件没删掉。关掉所有 ${state.name} 窗口后再点一次「帮我清理」；还是不行，请联系客服。`)
        return
      }
      toast.show('清理好了。', 'ok')
      onClose()
    }, (cause) => {
      setCleaning(false)
      setProblem(errorMessage(cause))
    })
  }
  const copy = <Button size="sm" icon={Copy} testId="manual-uninstall-copy" onClick={() => {
    void navigator.clipboard.writeText(state.manualCommand ?? '').then(() => setCopied(true)).catch(() => setCopied(false))
  }}>复制命令</Button>
  const copiedNote = copied && <span role="status">命令已复制</span>
  const support = onHelp && (!state.manualCommand || problem)
    ? <Button testId="manual-uninstall-support" onClick={onHelp} disabled={cleaning}>找客服</Button>
    : null
  return <Dialog open title={tool ? `${state.name} 还有文件没删干净` : `${state.name} 需要手动清理`} width={640} onClose={onClose} busy={cleaning} testId="manual-uninstall"
    footer={<>{support}<Button onClick={onClose} disabled={cleaning}>知道了</Button></>}>
    <p role="alert" data-testid="manual-uninstall-reason">{state.reason}</p>
    {state.manualCommand ? <>
      <p>{tool ? `点「帮我清理」，星芒再核对一遍就替你删掉；也可以复制下面的命令，在${shell}里自己执行。` : `在${shell}里执行下面这条命令即可完成清理。`}</p>
      <pre className="v2-business-code" data-testid="manual-uninstall-command">{state.manualCommand}</pre>
      {tool ? <div className="v2-manual-uninstall-actions">
        <Button variant="primary" size="sm" icon={Trash2} loading={cleaning} testId="manual-uninstall-cleanup" onClick={clean}>帮我清理</Button>
        {copy}
        {copiedNote}
      </div> : <>{copy}{copiedNote}</>}
      {problem && <div role="alert" className="v2-callout is-bad" data-testid="manual-uninstall-cleanup-problem"><span>{problem}</span></div>}
    </> : <p>这次没能确认哪些文件能安全删掉，先别自己删，点「找客服」。</p>}
  </Dialog>
}
