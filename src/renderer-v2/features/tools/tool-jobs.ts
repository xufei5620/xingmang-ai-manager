import { clientConnections } from '../../registry/clients'
import { tools } from '../../registry/tools'
import type { ToolId } from './model'

// 「打开」排队时说在等谁（launchWaitLabel）：工具行任务的 key 就是工具或客户端的编号。
export function jobToolName(key: string): string | undefined {
  return tools.find((tool) => tool.id === key)?.name ?? clientConnections.find((client) => client.id === key)?.name
}

export function withoutTool<T>(record: Partial<Record<ToolId, T>>, tool: ToolId): Partial<Record<ToolId, T>> {
  if (!(tool in record)) return record
  const next = { ...record }
  delete next[tool]
  return next
}
