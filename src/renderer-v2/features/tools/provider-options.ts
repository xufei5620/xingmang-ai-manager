// 记录页和扩展三页共用的工具选单（#1070 第 11 步，从 pages-management.tsx 原样搬来，只加了 export）：认不认这个
// 工具（下线的 Gemini 不认）、按导航次序排的命令行工具选项、工具编号换成名字。
import { tools } from '../../registry/tools'
import { isActiveProviderId, type ActiveProviderId } from '../../../../electron/catalog'

// 已下线的工具（Gemini）不在筛选、备份、扩展里出现，主进程回来的数据里带着它也不认。
export function isProvider(id: unknown): id is ActiveProviderId {
  return isActiveProviderId(id)
}
export const providerOptions = tools
  .filter((tool) => tool.kind === 'cli' && isProvider(tool.id))
  .map((tool) => ({ value: tool.id, label: tool.name }))
export function providerName(id: string) {
  return tools.find((tool) => tool.id === id)?.name ?? id
}
