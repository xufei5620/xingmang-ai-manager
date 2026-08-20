import type { WorkflowFile } from '../model'

export function canvasAutosaveGraphSignature(workflow: Pick<WorkflowFile, 'nodes' | 'edges'>): string {
  return JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges })
}

export function canvasAutosaveSignature(workflow: Pick<WorkflowFile, 'nodes' | 'edges' | 'mediaGroups'>): string {
  return JSON.stringify({
    mediaGroups: workflow.mediaGroups ?? {},
    nodes: workflow.nodes,
    edges: workflow.edges,
  })
}

export function canvasAutosaveErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
  if (/EPERM|EACCES|EBUSY|operation not permitted|写入被系统占用/i.test(message)) {
    return '自动保存失败：项目文件正被占用，请稍后再试。当前窗口里的提示词还在，先不要关画布。'
  }
  return `自动保存失败：${message}`
}
