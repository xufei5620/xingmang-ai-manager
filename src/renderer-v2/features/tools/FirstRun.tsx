import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '../../ui'
import type { ToolFirstRun } from '../../registry/tools'

/**
 * 装完之后的第一分钟（功能清单 A6）。本产品的客户不是来学协议的，他们买的是
 * 「能用上 Claude Code」；装好 CLI 之后剩下的黑底终端和一个闪烁光标，是这批用户
 * 流失最集中的一屏。所以这里给的是两样可以直接复制的东西：启动命令，和一句
 * 粘进去就能看到结果的中文提示词。
 *
 * 剪贴板失败也要有回音：打包版里 navigator.clipboard 仍可能被系统拒绝，
 * 按了没反应会让用户以为是工具坏了。
 *
 * 调用方要给它一个随工具变化的 key：换了工具就得重置这句回音，否则关掉
 * Claude Code 那张卡之后，接上来的 Codex 卡上会挂着一句「已复制」。
 */
export function FirstRunSteps({ name, firstRun, testId, gitHint }: { name: string; firstRun: ToolFirstRun; testId: string; gitHint?: string }) {
  const [copied, setCopied] = useState<'' | 'command' | 'prompt'>('')
  const [failed, setFailed] = useState(false)
  const copy = (part: 'command' | 'prompt', value: string) => {
    void navigator.clipboard.writeText(value)
      .then(() => { setCopied(part); setFailed(false) })
      .catch(() => { setCopied(''); setFailed(true) })
  }
  return <div className="v2-first-run" data-testid={testId}>
    <p>在你要写代码的那个文件夹里新开一个终端，敲这一条就能启动（点「打开」时，星芒替你敲的也是它）：</p>
    <div className="v2-first-run-line">
      <code className="v2-business-code" data-testid={`${testId}-command`}>{firstRun.command}</code>
      <Button size="sm" icon={Copy} testId={`${testId}-copy-command`} onClick={() => copy('command', firstRun.command)}>复制命令</Button>
    </div>
    <p>{name} 起来之后，把下面这句话粘进去，看看它能做什么：</p>
    <div className="v2-first-run-line">
      <code className="v2-business-code" data-testid={`${testId}-prompt`}>{firstRun.prompt}</code>
      <Button size="sm" icon={Copy} testId={`${testId}-copy-prompt`} onClick={() => copy('prompt', firstRun.prompt)}>复制这句话</Button>
    </div>
    {copied && <p className="v2-first-run-note" role="status">{copied === 'command' ? '命令已复制，粘到终端里回车即可' : '这句话已复制，粘到工具里回车即可'}</p>}
    {failed && <p className="v2-first-run-note" role="status">没能写进剪贴板，手动选中上面的文字复制就行</p>}
    {gitHint && <p className="v2-first-run-note is-warn" role="status" data-testid={`${testId}-git-hint`}>{gitHint}</p>}
  </div>
}
