import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '../../ui'
import { runtimeDisplayName, type ManagedRuntimeId, type RuntimeInstallGuide } from './runtime-install-guide'

/**
 * macOS 上这两个运行环境要客户自己装（见 runtime-install-guide.ts）。步骤上屏、
 * 命令可复制，但命令由客户自己粘进「终端」执行：本程序从不代跑终端命令。
 *
 * 剪贴板失败也要有回音，理由同 FirstRun.tsx：打包版里 navigator.clipboard 仍可能
 * 被系统拒绝，按了没反应会让人以为软件坏了。
 */
export function RuntimeInstallHint({ runtime, guide }: { runtime: ManagedRuntimeId; guide: RuntimeInstallGuide }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const command = guide.command
  function copy(value: string) {
    void navigator.clipboard.writeText(value)
      .then(() => { setCopied(true); setFailed(false) })
      .catch(() => { setCopied(false); setFailed(true) })
  }
  return <div className="v2-runtime-guide" data-testid={`home-runtime-guide-${runtime}`}>
    <p>{guide.summary}</p>
    <ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
    {command && <div className="v2-runtime-guide-line">
      <code className="v2-business-code" data-testid={`home-runtime-command-${runtime}`}>{command}</code>
      <Button size="xs" variant="ghost" icon={Copy} testId={`home-runtime-copy-${runtime}`} onClick={() => copy(command)}>复制命令</Button>
    </div>}
    {copied && <p className="v2-runtime-guide-note" role="status">命令已复制，粘到「终端」里回车即可</p>}
    {failed && <p className="v2-runtime-guide-note" role="status">没能写进剪贴板，手动选中上面的命令复制就行</p>}
    <p className="v2-runtime-guide-note">装 {runtimeDisplayName(runtime)} 的完整步骤在教程里也有一份。</p>
  </div>
}
