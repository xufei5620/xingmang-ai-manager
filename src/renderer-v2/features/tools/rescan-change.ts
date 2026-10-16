import type { ExternalClientStatus } from '../../../../electron/ipc-contract'
import { presentTools, type ToolboxSnapshot } from './model'

/**
 * 首页「重新检测」点之前、检测完各取一份；一样就说一句「检测完了，工具和运行环境都没有变化」（v4 批 04），
 * 免得客户以为没点上。只比首页看得见的：每个工具装没装、版本、用哪个账号、什么模型、有没有更新，外接客户端
 * 装没装、连没连上、第三方配置齐没齐、配置读没读坏、模型，运行环境装没装、版本。null = 还没有检测结果，不比。
 */
export function rescanFingerprint(snapshot: ToolboxSnapshot | null, external: readonly ExternalClientStatus[]): string | null {
  if (!snapshot) return null
  const runtime = snapshot.system.runtime
  return JSON.stringify([
    presentTools(snapshot).map((tool) => [tool.id, tool.status.installed, tool.status.version, Boolean(tool.status.detectionFailed), tool.source, tool.model ?? null, tool.configured, tool.updateAvailable]),
    (['node', 'npm', 'git', 'python'] as const).map((id) => [id, runtime[id].installed, runtime[id].version, Boolean(runtime[id].detectionFailed)]),
    external.map((client) => [client.tool, client.installed, client.version, client.configured, client.configurationSource, client.configurationReady ?? null, Boolean(client.configurationError), client.model ?? null, Boolean(client.detectionError), client.officialAccount === true]),
  ])
}
