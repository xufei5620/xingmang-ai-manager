import { useRef } from 'react'
import { Button, Dialog } from '../../ui'
import { nodeReplaceReason } from './node-replace'

/**
 * 换 Node.js 之前问一次（第十八批 4）。错误框里的「更新 Node.js」与检查页
 * Node.js 那一行的「立即更新」共用。只说清会发生什么，不讲原理：会弹一次系统确认、装好的
 * 工具不用重装、客户自己的项目一般不受影响。
 *
 * 焦点先落在说明上：换 Node.js 要下载、要系统确认，不能一次回车就开始。
 */
export function NodeReplaceDialog({ version, onConfirm, onClose }: {
  version: string | null | undefined
  onConfirm: () => void
  onClose: () => void
}) {
  const intro = useRef<HTMLDivElement>(null)
  return <Dialog
    open
    title="是否更新 Node.js？"
    onClose={onClose}
    initialFocus={intro}
    testId="node-replace-dialog"
    footer={<>
      <Button onClick={onClose} testId="node-replace-cancel">暂不更新</Button>
      <Button variant="primary" onClick={onConfirm} testId="node-replace-confirm">立即更新</Button>
    </>}
  >
    <div ref={intro} tabIndex={-1}>
      <p data-testid="node-replace-reason">{nodeReplaceReason(version)}</p>
      <p>星芒将下载并安装官方新版 Node.js，之后安装和打开工具均使用新版。过程中 Windows 可能弹出「是否允许此应用对你的设备进行更改」，请点击「是」。</p>
      <p>已安装的工具无需重新安装，您自行使用 Node.js 开发的项目通常也不受影响。</p>
    </div>
  </Dialog>
}
