import type { DiagnosticFolderTarget } from '../../../../electron/ipc-contract'

type DetailValue = boolean | number | string | null

/**
 * 检查页「打开文件夹」：「文档」不让写、新项目或 AI 作品改放到个人文件夹时，
 * 主进程在那一行的 details 里标上是哪一个（第十二批 9）。渲染层只把这个名字传回去，
 * 路径由主进程自己算。
 */
export function diagnosticFolderTarget(item: { details?: Record<string, DetailValue> }): DiagnosticFolderTarget | null {
  const target = item.details?.openFolder
  return target === 'projects' || target === 'ai-output' ? target : null
}

/** 主进程说没打开（AI 作品位置还没定下来）时，按失败显示的那句话。 */
export const diagnosticFolderUnavailableMessage = '这个文件夹现在打不开，重新打开本软件后再试一次。'
