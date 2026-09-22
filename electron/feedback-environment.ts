import { cliCatalog, providerIds, type ProviderId } from './catalog'
import type { NativeConfigInspection } from './config-files'
import { externalClientNames, externalToolIds, type ExternalClientStatus } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'
import type { CliStatus, DesktopAppStatus, NetworkRegion, SystemSnapshot, ToolStatus } from './system-service'
import {
  describeWindowsExecutionProbeFailure,
  type WindowsCliExecutionMode,
  type WindowsExecutionProbeFailureReason,
} from './windows-elevation'

/**
 * 反馈报告头部那段「工具与配置」的纯函数构造器。客服收到报告的第一句总是
 * 「你的 Claude Code 是什么版本、怎么装的、配置指向哪」——这三件事本机早就
 * 知道，没必要让用户再答一轮。
 *
 * 刻意不做的事：不触发任何扫描或网络探测（只读主进程已有的上一份快照），
 * 不写 Key、不写任何地址（base URL 也不写）、不写站点名。配置这一层只回答
 * 「是 / 否 / 未配置 / 未读到」，判断依据是 inspectProviderConfig 已经算好的
 * matchesRelay，不在这里重新拼地址。
 */

export type FeedbackCliStatus = Pick<
  CliStatus,
  'installed' | 'version' | 'installSource' | 'detectionFailed' | 'versionAdvice'
>

export type FeedbackCliConfig = Pick<
  NativeConfigInspection,
  'exists' | 'hasApiKey' | 'matchesRelay' | 'model'
>

/**
 * 三个外部客户端（WorkBuddy / Claude Desktop / OpenCode）在报告里要答的和四个
 * CLI 是同三件事：装没装、什么版本、配置指没指向当前账号。0.2.6 接进来之后这
 * 一段一直只有 CLI，用户反馈「桌面端连不上」时客服手里没有任何线索。
 */
export type FeedbackExternalClient = Pick<
  ExternalClientStatus,
  'tool' | 'installed' | 'version' | 'model' | 'configurationSource' | 'detectionError'
>

export interface FeedbackEnvironmentInput {
  /** 上一次扫描的缓存快照；还没扫过（或取不到）时传 null，整段写「未能读取」。 */
  clis: Readonly<Record<ProviderId, FeedbackCliStatus>> | null
  /** 读一个工具的本地配置。抛错或返回 null 都按「未读到」处理。 */
  readConfig: (provider: ProviderId) => FeedbackCliConfig | null
  /** 上一次客户端检测的缓存快照；没检测过传 null，三行都写「未能读取」。 */
  externalClients?: readonly FeedbackExternalClient[] | null
}

const unreadable = '未能读取'

function installSourceLabel(status: FeedbackCliStatus, provider: ProviderId): string | null {
  // Grok 的安装与更新本来就走原生通道，首页对它不做来源标注（见 #287），
  // 报告里同样不标，免得客服照着一句「其他来源」去指导用户重装。
  if (provider === 'grok') return null
  switch (status.installSource) {
    case 'npm':
      return '应用托管'
    case 'native':
      return '官方安装器'
    case 'path':
      return '其他来源'
    default:
      return null
  }
}

function installationText(status: FeedbackCliStatus, provider: ProviderId): string {
  if (status.detectionFailed === true) return '检测失败'
  if (!status.installed) return '未安装'
  const version = status.version?.trim()
  const source = installSourceLabel(status, provider)
  const head = version ? `已安装 ${version}` : '已安装（版本未知）'
  return source ? `${head}（${source}）` : head
}

function recommendationText(status: FeedbackCliStatus): string {
  const advice = status.versionAdvice
  if (!advice) return ''
  const parts: string[] = []
  if (advice.recommendedVersion) parts.push(`推荐 ${advice.recommendedVersion}`)
  if (advice.blockedReason) parts.push(`已知问题: ${advice.blockedReason}`)
  return parts.length ? `，${parts.join('，')}` : ''
}

function configText(config: FeedbackCliConfig | null): string {
  if (!config) return `配置：${unreadable}`
  if (!config.exists) return '配置：未配置'
  const account = config.matchesRelay ? '指向当前账号' : '未指向当前账号'
  const model = config.model.trim()
  return model ? `配置：${account}，模型 ${model}` : `配置：${account}`
}

function readConfigQuietly(
  provider: ProviderId,
  readConfig: FeedbackEnvironmentInput['readConfig'],
): FeedbackCliConfig | null {
  try {
    return readConfig(provider)
  } catch {
    // 一个工具的配置读不出来（权限、目录被替换成链接）不该让整份报告失败。
    return null
  }
}

/**
 * 客户端的配置这一层只答「是 / 否 / 未配置 / 未读到」，判断依据是检测时已经算
 * 好的 configurationSource，不在这里重新读配置文件，也不写地址、不写站点名。
 */
function externalConfigText(client: FeedbackExternalClient): string {
  if (client.configurationSource === 'unknown') return `配置：${unreadable}`
  if (client.configurationSource === 'missing') return '配置：未配置'
  const account = client.configurationSource === 'xingmang' ? '指向当前账号' : '未指向当前账号'
  const model = client.model?.trim()
  return model ? `配置：${account}，模型 ${model}` : `配置：${account}`
}

function externalInstallationText(client: FeedbackExternalClient): string {
  if (client.detectionError) return '检测失败'
  if (!client.installed) return '未安装'
  const version = client.version?.trim()
  // 客服问的第一句就是版本号，所以装了但读不出版本也要说清楚是哪一种。
  return version ? `已安装 ${version}` : '已安装（版本未知）'
}

function externalClientLine(tool: ExternalToolId, clients: readonly FeedbackExternalClient[] | null | undefined): string {
  const name = externalClientNames[tool]
  const client = clients?.find((entry) => entry.tool === tool)
  if (!client) return `${name}: ${unreadable}`
  return `${name}: ${externalInstallationText(client)}；${externalConfigText(client)}`
}

export function buildFeedbackEnvironmentLines(input: FeedbackEnvironmentInput): string[] {
  const clis = providerIds.map((provider) => {
    const name = cliCatalog[provider].name
    const status = input.clis?.[provider]
    if (!status) return `${name}: ${unreadable}`
    const installation = `${installationText(status, provider)}${recommendationText(status)}`
    return `${name}: ${installation}；${configText(readConfigQuietly(provider, input.readConfig))}`
  })
  return [...clis, ...externalToolIds.map((tool) => externalClientLine(tool, input.externalClients))]
}

export type FeedbackRuntimeTool = Pick<ToolStatus, 'installed' | 'version' | 'path' | 'tooOld' | 'detectionFailed'>

export type FeedbackCodexDesktop = FeedbackRuntimeTool & Pick<DesktopAppStatus, 'appVersion' | 'running'>

export interface FeedbackRuntimeSnapshot {
  checkedAt: SystemSnapshot['checkedAt']
  runtime: Readonly<Record<keyof SystemSnapshot['runtime'], FeedbackRuntimeTool>>
  codexDesktop: FeedbackCodexDesktop
  region: NetworkRegion
}

export interface FeedbackRuntimeInput {
  /** 上一次扫描的快照；还没扫过时传 null，工具与网络几行都写「未能读取」。 */
  snapshot: FeedbackRuntimeSnapshot | null
  platform: NodeJS.Platform
  /** 只有 Windows 有意义；其他平台传 null，这一行不出。 */
  executionMode: WindowsCliExecutionMode | null
  /**
   * 启动时那次「是不是管理员」探测的结果：null = 探测成功，原因 = 探测失败、按管理员
   * 处理。缺省 = 不知道（旧行为），trusted-only 那一行照旧写「或无法确认」。
   */
  executionProbeFailure?: WindowsExecutionProbeFailureReason | null
  /** 软件主程序所在目录。 */
  appDirectory: string | null
  dataDirectory: string | null
  /** 本软件替用户装 CLI 的托管目录；算不出来传 null。 */
  managedDirectory: string | null
  locale: string | null
  timeZone: string | null
}

const runtimeToolNames: Readonly<Record<keyof SystemSnapshot['runtime'], string>> = {
  node: '系统 Node.js',
  npm: 'npm',
  python: 'Python',
  git: 'Git',
}

// 网络位置只写粗粒度的地区，公网 IP 和国家代码刻意不进报告：这份报告要发到
// 客服群里，而客服排障只需要知道该走国内还是海外的下载源。
const regionLabels: Readonly<Record<NetworkRegion, string>> = {
  'mainland-china': '中国大陆',
  'outside-mainland-china': '中国大陆以外',
  unknown: '未知',
}

function runtimeToolText(status: FeedbackRuntimeTool): string {
  if (status.detectionFailed === true) return '检测失败'
  if (!status.installed) return '未安装'
  const version = status.version?.trim()
  const head = version ? `已安装 ${version}` : '已安装（版本未知）'
  const tooOld = status.tooOld === true ? '，版本过低' : ''
  const location = status.path?.trim() ? `，位置 ${status.path.trim()}` : ''
  return `${head}${tooOld}${location}`
}

function codexDesktopText(status: FeedbackCodexDesktop): string {
  if (status.detectionFailed === true) return '检测失败'
  if (!status.installed) return '未安装'
  // 渲染层展示的也是 appVersion 优先（features/tools/model.ts），两边说同一个号。
  const version = status.appVersion?.trim() || status.version?.trim()
  const head = version ? `已安装 ${version}` : '已安装（版本未知）'
  return status.running ? `${head}，正在运行` : head
}

function executionModeText(
  mode: WindowsCliExecutionMode,
  probeFailure: WindowsExecutionProbeFailureReason | null | undefined,
): string {
  if (mode === 'same-user') return '普通用户'
  // trusted-only 也是令牌探测失败时的保守回退（resolveWindowsCliExecutionMode）。
  // 知道是哪一种就直说；不知道时把「或无法确认」一并写上，免得客服据此断定用户
  // 右键了管理员运行。
  if (probeFailure) return `按管理员处理（没能确认：${describeWindowsExecutionProbeFailure(probeFailure)}）`
  if (probeFailure === null) return '以管理员身份运行'
  return '以管理员身份运行（或无法确认，按管理员处理）'
}

/**
 * 从扫描快照里只挑报告要用的字段。网络位置在这一步就只剩 region：公网 IP 与
 * 国家代码不进入报告构造器，后面怎么改排版都漏不出去。
 */
export function pickFeedbackRuntimeSnapshot(snapshot: SystemSnapshot | null): FeedbackRuntimeSnapshot | null {
  if (!snapshot) return null
  return {
    checkedAt: snapshot.checkedAt,
    runtime: snapshot.runtime,
    codexDesktop: snapshot.desktopApps.codex,
    region: snapshot.network.region,
  }
}

/**
 * 客服排障最先问的是「你 Node 几、装在哪」「是不是管理员模式」「国内还是海外
 * 网络」。这些主进程早就知道，这里只把上一次扫描的快照排成几行，不为生成报告
 * 再发任何探测。路径原样给出，家目录由 runtime-log 统一换成占位符（I13）。
 */
export function buildFeedbackRuntimeLines(input: FeedbackRuntimeInput): string[] {
  const lines: string[] = []
  const snapshot = input.snapshot
  for (const key of Object.keys(runtimeToolNames) as Array<keyof SystemSnapshot['runtime']>) {
    const status = snapshot?.runtime[key]
    lines.push(`${runtimeToolNames[key]}: ${status ? runtimeToolText(status) : unreadable}`)
  }
  lines.push(`Codex 桌面端: ${snapshot ? codexDesktopText(snapshot.codexDesktop) : unreadable}`)
  lines.push(`网络位置: ${snapshot ? regionLabels[snapshot.region] : unreadable}`)
  if (input.platform === 'win32' && input.executionMode) {
    lines.push(`运行权限: ${executionModeText(input.executionMode, input.executionProbeFailure)}`)
  }
  lines.push(`软件位置: ${input.appDirectory?.trim() || unreadable}`)
  lines.push(`数据目录: ${input.dataDirectory?.trim() || unreadable}`)
  if (input.managedDirectory?.trim()) lines.push(`托管目录: ${input.managedDirectory.trim()}`)
  const locale = input.locale?.trim()
  const timeZone = input.timeZone?.trim()
  if (locale || timeZone) lines.push(`系统语言与时区: ${locale || '未知'}，${timeZone || '未知'}`)
  if (snapshot?.checkedAt) lines.push(`以上来自 ${snapshot.checkedAt} 的扫描`)
  return lines
}
