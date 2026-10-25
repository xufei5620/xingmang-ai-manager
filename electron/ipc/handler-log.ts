// 主窗口业务通道调用成功那一行日志怎么写：中文说法、带哪些字段、记 debug 还是 info，加速页轮询状态时怎么去重。
// ipc.ts 里的 registerTrustedHandler 记日志用，detection-failures.ts 借用工具名那一个（#1070 第 7 步从 ipc.ts 原样搬来）。
// 日志里不放密钥、令牌和完整路径（I13）。
import { cliCatalog, isProviderId } from '../catalog'
import { requestDiagnosticsOf } from '../request-diagnostics'
import { ipcChannelPolicies, type IpcInvokeChannel } from '../ipc-channel-policy'
import { isRecord } from '../input-guards'

/**
 * 开机先摆上次客户端检测结果的那一读（已知13）只读本机文件、跟谁登录着无关，不陪账号恢复等：
 * 恢复要连服务器，网慢的时候首页那几行又要空着等。格式不对的照样进 external-clients:scan 的
 * 处理器（handlers/external-clients.ts）报错。
 */
export function readsCachedExternalClientsOnly(channel: string, args: readonly unknown[]): boolean {
  return channel === 'external-clients:scan' && isRecord(args[1]) && args[1].cachedOnly === true
}

export function providerDisplayName(value: unknown): string | null {
  return isProviderId(value) ? cliCatalog[value].name : null
}

function collectionSize(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (!isRecord(value)) return null
  for (const key of ['items', 'entries', 'models', 'sessions', 'servers', 'skills', 'plugins']) {
    if (Array.isArray(value[key])) return value[key].length
  }
  return typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : null
}

export function ipcSuccessMessage(channel: IpcInvokeChannel, args: unknown[], result: unknown): string {
  const label = ipcChannelPolicies[channel].label ?? channel
  const provider = providerDisplayName(args[0])
    ?? (isRecord(args[0]) ? providerDisplayName(args[0].provider) : null)
  const count = collectionSize(result)
  if (channel === 'workspace:choose' && result === null) return '已取消选择工作目录'
  if ((channel === 'sessions:export' || channel === 'provider-sessions:export') && result === null) {
    return '已取消导出会话'
  }
  if ((channel === 'diagnostics:export' || channel === 'runtime-logs:export-feedback') && result === null) {
    return '已取消导出报告'
  }
  if ((channel === 'chat-history:export-text' || channel === 'data-transfer:export') && result === null) return '已取消导出'
  if (channel === 'data-transfer:import' && result === null) return '已取消导入'
  if (channel === 'video:save-as' && isRecord(result) && result.saved === false) return '已取消另存视频'
  if (channel === 'config:save' && provider) return `${provider} 配置已保存`
  if (channel === 'cli:install' && provider) return `${provider} 安装或更新已完成`
  if (channel === 'runtime:install-node') return 'Node.js LTS 自动安装完成'
  if (channel === 'runtime:install-python') return 'Python 3.12 自动安装完成'
  if (channel === 'cli:uninstall' && provider) return `${provider} 卸载已完成`
  // 还剩文件时不写「完成」：客服看反馈报告要分得清是删干净了，还是客户又点了一次。
  if (channel === 'cli:clean-uninstall-leftovers' && provider && isRecord(result) && typeof result.remaining === 'number') {
    return result.remaining > 0 ? `${provider} 卸载残留还剩 ${result.remaining} 个文件没删掉` : `${provider} 卸载残留已清理`
  }
  if (channel === 'cli:check-update' && provider) return `${provider} 更新检查已完成`
  if (channel === 'desktop:uninstall-codex') return 'Codex 桌面端卸载已完成'
  if (channel === 'desktop:reset-codex') return 'Codex 桌面端重置已完成'
  if (channel === 'cli:launch' && provider) return `${provider} 终端已打开`
  // 这个调用只是把安装交出去，真装没装上要等安装程序回话；写「完成」会让客服看反馈报告时
  // 以为已经装好了，紧跟着的失败反而像是另一回事。
  if (channel === 'update:install' && isRecord(result) && result.postponed === true) return '还有工具在装，这次没装新版本'
  if (channel === 'update:install') return '已把新版本交给安装程序，装没装上看下一条更新状态'
  // 开机先摆的上次结果（已知13）只读了本机一个文件，没检测；写「检测完成」会让客服看反馈报告时
  // 以为这次已经检测过了，真的那轮卡住或没跑完就分不出来。
  if (readsCachedExternalClientsOnly(channel, args)) {
    return count ? `已先显示上次的客户端检测结果，共 ${count} 项` : '没有可先显示的上次客户端检测结果'
  }
  if ((channel === 'models:list' || channel === 'models:list-configured') && count !== null) {
    return `可用模型读取完成，共 ${count} 个`
  }
  if (channel === 'desktop:launch-codex') {
    return args[0] === 'restart' ? 'Codex 桌面端已重启' : 'Codex 桌面端已打开'
  }
  if (channel === 'extensions:mutate' && isRecord(args[0])) {
    const action = typeof args[0].action === 'string' ? args[0].action : '操作'
    const kind = typeof args[0].kind === 'string' ? args[0].kind.toUpperCase() : '扩展'
    return `${provider ? `${provider} ` : ''}${kind} ${action} 已完成`
  }
  if (count !== null) return `${label}完成，共 ${count} 项`
  return `${label}完成`
}

export function ipcLogDetail(channel: string, args: unknown[], result: unknown, durationMs: number): Record<string, unknown> {
  const detail: Record<string, unknown> = { durationMs }
  const first = args[0]
  const provider = providerDisplayName(first)
    ?? (isRecord(first) && isProviderId(first.provider) ? first.provider : null)
  if (provider) detail.provider = provider
  if (channel === 'config:save' && isRecord(first)) {
    detail.mode = first.mode
    detail.model = first.model
  }
  if (channel === 'desktop:launch-codex') detail.mode = first
  if (channel === 'settings:save' && isRecord(first)) detail.theme = first.theme
  if (channel === 'extensions:mutate' && isRecord(first)) {
    detail.kind = first.kind
    detail.action = first.action
    detail.id = first.id
  }
  // 「装上了但连不上」是这一页最常见的工单。日志里只留条数，原因文本来自 CLI
  // 输出，不进日志（I13）。
  if (channel === 'extensions:check-mcp-health' && isRecord(result) && Array.isArray(result.entries)) {
    detail.supported = result.supported
    detail.failed = result.entries.filter(
      (entry) => isRecord(entry) && entry.state === 'failed',
    ).length
  }
  const count = collectionSize(result)
  if (count !== null) detail.itemCount = count
  if (channel === 'diagnostics:run' && isRecord(result) && isRecord(result.counts)) {
    detail.counts = result.counts
  }
  // 站点切换对用户无感（产品决定），界面永不显示 siteId；但客服排查一条
  // 自检工单时必须知道当时走的是哪个后端，所以只在日志里留下它。
  if (channel === 'diagnostics:check-connection' && isRecord(result)) {
    // 自检现在按工具各跑一次，一条工单里会有四行日志，provider 是分辨它们的那一列。
    detail.provider = result.provider
    detail.layer = result.layer
    detail.ok = result.ok
    detail.siteId = result.siteId
    detail.status = result.status
  }
  if (channel === 'diagnostics:probe-codex-responses' && isRecord(result)) {
    detail.layer = result.layer
    detail.ok = result.ok
    detail.verificationLevel = result.verificationLevel
    detail.status = result.status
  }
  // 外部客户端同理，分辨它们的那一列是 tool。归因层与站点都留，客户端的
  // 密钥与地址一概不留（I13）。
  if (channel === 'diagnostics:check-external-connection' && isRecord(result)) {
    detail.tool = result.tool
    detail.layer = result.layer
    detail.ok = result.ok
    detail.installed = result.installed
    detail.siteId = result.siteId
    detail.status = result.status
  }
  // 登录、两步验证登上了也记走的哪条线路（request-diagnostics.ts）：同一个人先在直连上登不上、换到 CF
  // 登上了，客服要分得出来（三线路 7b）。只有挂着诊断的结果才有这一项。
  const request = requestDiagnosticsOf(result)
  if (request) detail.request = request
  return detail
}

/**
 * 加速页可见时每 15 秒读一次状态，每次成功都记一条的话，开一下午加速页就是上千
 * 条一模一样的记录。这里给出「状态有没有变」的比较键：剩余时长每秒都在走，不算
 * 变化；阶段、模式、线路、连上的时间点、错误与冲突任何一项变了才算。读不出形状
 * 时返回 null，照常记录。
 */
export function accelerationStateLogKey(result: unknown): string | null {
  if (!isRecord(result) || typeof result.scope !== 'string' || typeof result.phase !== 'string') return null
  const line = isRecord(result.line) && typeof result.line.id === 'string' ? result.line.id : null
  return JSON.stringify([
    result.scope,
    result.phase,
    result.mode ?? null,
    result.entitlementSource ?? null,
    line,
    result.connectedAt ?? null,
    result.error ?? null,
    Array.isArray(result.conflicts) ? result.conflicts : null,
  ])
}

export function ipcSuccessLevel(channel: string): 'debug' | 'info' {
  return /:(?:get|get-state|list|list-all|detail|status|inspect)$/.test(channel) ? 'debug' : 'info'
}

// 轮询通道（ipc-channel-policy.ts 里 log: 'polling'）的成功慢过这么久，照记 info。
export const SLOW_POLLING_SUCCESS_MS = 3_000
