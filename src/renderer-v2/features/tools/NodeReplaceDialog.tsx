import { useRef } from 'react'
import { Button, Dialog } from '../../ui'
import { nodeReplaceReason } from './node-replace'

/**
 * 换 Node.js 之前问一次（第十八批 4）。错误框里的「换成新版 Node.js」与「安装卸载」页
 * 那一行的「换成新版」共用。只说清会发生什么，不讲原理：会弹一次系统确认、装好的
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
    title="换成新版 Node.js？"
    onClose={onClose}
    initialFocus={intro}
    testId="node-replace-dialog"
    footer={<>
      <Button onClick={onClose} testId="node-replace-cancel">先不换</Button>
      <Button variant="primary" onClick={onConfirm} testId="node-replace-confirm">换成新版</Button>
    </>}
  >
    <div ref={intro} tabIndex={-1}>
      <p data-testid="node-replace-reason">{nodeReplaceReason(version)}</p>
      <p>星芒会下载官方的新版 Node.js 装上，以后星芒装工具、打开工具都用新版。中途 Windows 可能弹一次「是否允许此应用对你的设备进行更改」，点「是」就行。</p>
      <p>已经装好的工具不用重装，你自己用 Node.js 做的项目一般也照常能用。</p>
    </div>
  </Dialog>
}
