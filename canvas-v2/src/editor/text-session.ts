import type { WorkflowNodeData } from '../model'
import type { TextOutputSelection } from './output-text-nodes'
import { maximumPromptLength } from '../persistence/workflow-schema'

export interface CanvasTextSession {
  id: string
  nodeId: string
  kind: string
  selection: TextOutputSelection
  title: string
  value: string
  scope: string
  references: string
  notice?: string
}

interface TextNode { id: string; type?: string; data: WorkflowNodeData }

export function assertTextSessionNode<T extends TextNode>(nodes: readonly T[], session: CanvasTextSession): T {
  const node = nodes.find((entry) => entry.id === session.nodeId)
  if (!node || node.type !== session.kind) throw new Error('原文字节点已删除或替换，请关闭后重新选择；编辑草稿仍保留')
  const value = session.selection === 'result' ? node.data.outputText ?? '' : node.data.prompt
  if (value !== session.value || session.selection === 'input' && JSON.stringify(node.data.promptReferences ?? []) !== session.references) {
    throw new Error('原文或生成结果已经变化，请先复制当前草稿，再重新打开；本次没有覆盖画布内容')
  }
  return node
}

export function assertTextDraft(text: string): void {
  if (typeof text !== 'string' || text.length > maximumPromptLength || text.includes('\0')) throw new Error(`文字最多 ${maximumPromptLength} 字，且不能包含空字符；正文没有被截断`)
}

export function textDownloadName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '')
  return `${safe || '星芒文字'}.txt`
}

export function downloadCanvasText(text: string, title: string): void {
  assertTextDraft(text)
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  try {
    link.href = url; link.download = textDownloadName(title); link.style.display = 'none'
    document.body.appendChild(link); link.click()
  } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
