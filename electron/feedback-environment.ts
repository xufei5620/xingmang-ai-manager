import { cliCatalog, providerIds, type ProviderId } from './catalog'
import type { NativeConfigInspection } from './config-files'
import type { CliStatus } from './system-service'

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

export interface FeedbackEnvironmentInput {
  /** 上一次扫描的缓存快照；还没扫过（或取不到）时传 null，整段写「未能读取」。 */
  clis: Readonly<Record<ProviderId, FeedbackCliStatus>> | null
  /** 读一个工具的本地配置。抛错或返回 null 都按「未读到」处理。 */
  readConfig: (provider: ProviderId) => FeedbackCliConfig | null
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

export function buildFeedbackEnvironmentLines(input: FeedbackEnvironmentInput): string[] {
  return providerIds.map((provider) => {
    const name = cliCatalog[provider].name
    const status = input.clis?.[provider]
    if (!status) return `${name}: ${unreadable}`
    const installation = `${installationText(status, provider)}${recommendationText(status)}`
    return `${name}: ${installation}；${configText(readConfigQuietly(provider, input.readConfig))}`
  })
}
