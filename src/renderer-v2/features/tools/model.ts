import type { AccountSourceTarget, AppConfigSummary, CliStatus, CliVersionAdvice, DesktopAppStatus, PlatformCapabilities, ProviderConfigSummary, ProviderId, SystemSnapshot, ToolStatus } from '../../../../electron/ipc-contract'
import { snapshotErrorMessage } from '../../business-common'
import { tools } from '../../registry/tools'
import {
  getSourceMarkerStorage,
  readManualSourceMarker,
  type SourceMarkerStorage,
} from './source-marker'

export type ToolId = ProviderId | 'codexDesktop'
/**
 * `changed` 是 `unknown` 里被单独拎出来的一种：主进程认得出这份配置原本是替
 * 当前账号写的，之后被改动过。其余判不准的仍旧是 `unknown`，两者在能不能自动
 * 改写这件事上一模一样，区别只在首页说哪句话、给不给修复入口。
 */
export type ToolSource = 'account' | 'official' | 'manual' | 'unknown' | 'changed' | 'missing'
export interface ToolboxSnapshot {
  system: SystemSnapshot
  config: AppConfigSummary
  platform: PlatformCapabilities
}
export interface ToolPresentation {
  id: ToolId
  provider: ProviderId
  name: string
  vendor: string
  status: ToolStatus
  source: ToolSource
  model: string
  configured: boolean
  /**
   * 这个工具的配置目录已经在磁盘上（主进程 inspect 时看到的）。false 有两种
   * 情况：还没写过配置，或者这一遍配置整块没读到——两种都不该让「打开配置
   * 文件夹」点下去报错，所以一律置灰。
   */
  configDirectoryReady: boolean
  updateAvailable: boolean
  currentVersion: string | null
  latestVersion: string | null
  /** 已验证版本名单(N1)对这一行的建议;Codex 桌面端与没有名单的工具为 null。 */
  versionAdvice: CliVersionAdvice | null
  /** 本工具最近一次更新前的版本、还能退回去时给出;缺省 = 没有可退的版本。 */
  revertVersion?: string | null
  error: string | null
}

export type ToolAvailabilityState = 'unknown' | 'detectionFailed' | 'installed' | 'missing'

export interface ToolAvailability {
  state: ToolAvailabilityState
  /** 状态标签文案。 */
  label: string
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
  /** 没有版本号时代替版本号的那句话。 */
  versionFallback: string
  /** 探测失败的原因原文;其余状态为 null。 */
  reason: string | null
}

/**
 * 装没装这件事有四种答案,不是两种。探测失败说明这次什么都没问出来,把它画成
 * 「未安装」会让用户对着一个其实装好了的工具反复点安装(issue #17 ①、#10);
 * 版本号同理,没探到不等于「未找到版本」。
 *
 * 这里刻意不引入真正的第三态 broken(装了但跑不起来):那要改主进程的探测异常
 * 分类,值得单开一条。
 */
export function toolAvailability(
  status: Pick<ToolStatus, 'installed' | 'detectionFailed' | 'detectionError' | 'installSource'> | null | undefined,
  statusUnknown = false,
): ToolAvailability {
  if (status?.detectionFailed === true) {
    return {
      state: 'detectionFailed', label: '检测失败', tone: 'bad', versionFallback: '版本未读到',
      reason: snapshotErrorMessage(status.detectionError) ?? '检测没有完成，装没装无法确认',
    }
  }
  if (statusUnknown) {
    return { state: 'unknown', label: '状态未读到', tone: 'warn', versionFallback: '版本未读到', reason: null }
  }
  return status?.installed === true
    ? { state: 'installed', label: installedLabel(status.installSource), tone: 'ok', versionFallback: '未找到版本', reason: null }
    : { state: 'missing', label: '未安装', tone: 'neutral', versionFallback: '未找到版本', reason: null }
}

/**
 * 已装工具的状态标签如实带上安装来源：官方原生安装器与 PATH 上的其他来源都不是
 * 本工具的 npm 通道装的，用户得知道这一点，否则会对着一个装好了的工具再点一次
 * npm 安装。npm 装的与来源未知的仍是朴素的「已安装」。
 */
export function installedLabel(installSource: ToolStatus['installSource']): string {
  if (installSource === 'native') return '已安装（官方安装器）'
  if (installSource === 'path') return '已安装（其他来源）'
  return '已安装'
}

/**
 * 失败对话框上的「复制路径」要复制的那个目录。已经装上的用探测到的安装目录；
 * 还没装上的（首次安装失败）用主进程算出的落点，那正是用户要去查写入权限、
 * 或加进杀毒白名单的地方。两者都没有就返回 null，界面据此不出这颗按钮。
 *
 * 路径带着用户名，只上屏与进剪贴板，不进日志、不进诊断导出（I13）。
 */
export function toolInstallDirectory(snapshot: ToolboxSnapshot | null, tool: ToolId | undefined): string | null {
  if (!snapshot || !tool) return null
  const status = tool === 'codexDesktop' ? snapshot.system.desktopApps.codex : snapshot.system.clis[tool]
  return status?.installDirectory ?? status?.installTarget ?? null
}

/**
 * 这台机器上这个工具的安装归不归本程序管。macOS 上 Codex 桌面端是 'external'：
 * 官方在 Mac 上只给自己下载的安装包，按钮点下去只能把人带到教程那一章，所以
 * 按钮不能再写「安装」，点完也不算一次失败（第七批 3）。
 */
export function needsManualInstall(snapshot: ToolboxSnapshot | null, tool: ToolId): boolean {
  if (!snapshot) return false
  const management = tool === 'codexDesktop'
    ? snapshot.platform.codexDesktop.install
    : snapshot.platform.cliInstall[providerFor(tool)]
  return management === 'external'
}

/**
 * 原生安装器或 PATH 上其他来源装的 CLI，本工具的 npm 安装/回滚通道不该碰它：跑一次
 * npm install 会在 npm 全局目录另装一份，与用户在用的那份并存。对这类安装隐藏
 * 「更新」「回到推荐版本」按钮，改用一句被动提示。
 */
export function isExternallyManagedInstall(
  status: Pick<ToolStatus, 'installed' | 'installSource'> | null | undefined,
): boolean {
  return status?.installed === true
    && status.installSource != null
    && status.installSource !== 'npm'
}

/** 外部来源安装时那句被动提示；npm 装的或来源未知的返回 null。 */
export function externalInstallHint(installSource: ToolStatus['installSource']): string | null {
  if (installSource === 'native') return '该版本由官方安装器管理，请用它自己的方式更新'
  if (installSource === 'path') return '该版本不是通过本工具安装的，更新请用它原本的安装方式'
  return null
}

/**
 * 更新检查失败的原因。`buildCliStatus` 早就写好了「版本号无法解析」「已安装版本
 * 高于源」两条,但渲染层一直没人读它们:用户只看到「更新」按钮不出现,不知道是
 * 已经最新还是这次根本没比出来。
 */
export function updateCheckFailure(
  status: Pick<CliStatus, 'updateCheck' | 'updateError'> | null | undefined,
): string | null {
  if (!status || status.updateCheck !== 'failed') return null
  return snapshotErrorMessage(status.updateError) ?? '这次更新检查没有完成，无法判断是否有新版本'
}

/** Whether the native status advertises a safe in-app uninstall operation. */
export function canUninstallTool(
  status: Pick<ToolStatus, 'uninstall'> | null | undefined,
  platformFallback = false,
): boolean {
  return status?.uninstall
    ? status.uninstall.available === true
    : platformFallback
}

export function isToolId(value: string): value is ToolId {
  return tools.some((tool) => tool.id === value)
}

export function providerFor(id: ToolId): ProviderId {
  return id === 'codexDesktop' ? 'codex' : id
}

export function sourceFor(
  config: ProviderConfigSummary,
  provider: ProviderId,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): ToolSource {
  // Codex 自己的「用 ChatGPT 登录」会把 auth.json 改成 ChatGPT 令牌，却不动仍指向
  // 当前账号服务的 config.toml：令牌被发给服务，每次请求都 401。这不是官方账号，
  // 是一份被改成半截的配置，按「被改过」提示，首页给出修复与切回官方两条路。
  if (provider === 'codex' && config.codexAuthMode === 'chatgpt') {
    return config.actualBaseUrl && sameServiceUrl(config.actualBaseUrl, config.baseUrl) ? 'changed' : 'official'
  }
  if (provider === 'gemini' && config.authType === 'oauth-personal') return 'official'
  if (config.hasApiKey && config.matchesRelay) {
    if (config.configurationOwnership === 'account' || config.configurationOwnership === 'manual') return config.configurationOwnership
    if (readManualSourceMarker(storage, config.baseUrl, provider)) return 'manual'
    // 「就用现在这份」写的就是上面那个本机标记，所以它排在这条前面：用户认过一次
    // 之后不再提。指纹对不上但密钥正好是当前账号缓存里的那把时也不提——那种情况
    // 连接本来就是通的，报「被改过」是假警。
    if (config.configurationAccountMatched === true) return 'account'
    return config.configurationOwnership === 'changed' ? 'changed' : 'unknown'
  }
  if (config.actualBaseUrl && !config.matchesRelay) return 'unknown'
  if (config.exists && !config.hasApiKey && provider !== 'grok') return 'official'
  // Grok 的 config.toml 装好就有（软件写了关自动更新），没填密钥不等于用官方账号；
  // 只有 ~/.grok/auth.json 里真有一份登录，才算在用 Grok 账号。
  if (provider === 'grok' && config.exists && !config.hasApiKey && config.grokLoginMode) return 'official'
  return 'missing'
}

function sameServiceUrl(left: string, right: string): boolean {
  return left.trim().replace(/\/+$/, '').toLowerCase() === right.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * 一键切回官方给 Claude Code、Codex 与 Grok。Gemini 的官方登录自 2026-06 起只剩企业版
 * Code Assist（registry/tools.ts 的 officialAccountNotes），小白点下去只会在 Google
 * 登录页反复失败；企业用户仍可在配置里选。
 */
const oneClickOfficialProviders: ReadonlySet<ProviderId> = new Set<ProviderId>(['claude', 'codex', 'grok'])

/**
 * 首页工具行「…」菜单里那一项切换指向哪边；null = 不给这一项。
 * 官方 → 当前账号对所有有官方来源的工具都给；当前账号（含手填、被改过）→ 官方
 * 只给上面两家。第三方配置与还没配置的不给：前者有专门的处理步骤，后者走「连接账号」。
 */
export function accountSwitchTarget(tool: Pick<ToolPresentation, 'provider' | 'source' | 'status'>): AccountSourceTarget | null {
  if (!tool.status.installed) return null
  // 来源没确认的（别家的 Key、同一个站上别的账号的 Key）同样一键改用当前账号：
  // 主进程先备份、再写入、再自检，连不上就恢复原样。
  if (tool.source === 'official' || tool.source === 'unknown') return 'account'
  if ((tool.source === 'account' || tool.source === 'manual' || tool.source === 'changed') && oneClickOfficialProviders.has(tool.provider)) return 'official'
  return null
}

/**
 * 来源没确认的配置，Key 落在哪（方案盘查 2026-09-25 第 8、10 条）：
 * - otherSite：地址不是当前账号所在的站。别家的站我们认不出、也用不了，界面上
 *   只说「不是当前账号的 Key」，不显示对方是谁。
 * - otherAccount：地址是当前账号的站，却认不出这把 Key 是当前账号的（同一个站上
 *   换了账号登录、旧版本手填的都是这种）。能用，但用量可能算到别的账号上。
 * 其余来源一律 null，「配置被改过」也是：那是替当前账号写过的配置，不能说成别人的 Key。
 */
export type ForeignKeyKind = 'otherSite' | 'otherAccount'

export function foreignKeyKind(config: Pick<ProviderConfigSummary, 'matchesRelay'>, source: ToolSource): ForeignKeyKind | null {
  if (source !== 'unknown') return null
  return config.matchesRelay ? 'otherAccount' : 'otherSite'
}

/**
 * 「改用 <账号名>」：用户要看见换成的是哪个账号（yoyo 9-25）。名字取首页问候语
 * 同一个登录名，太长的截断；没登录时说不出名字，退回「当前账号」。
 */
export function switchAccountLabel(username: string | null | undefined): string {
  const name = [...(username?.trim() ?? '')]
  if (!name.length) return '改用当前账号'
  return `改用 ${name.length > 16 ? `${name.slice(0, 15).join('')}…` : name.join('')}`
}

export function connectionReady(
  config: ProviderConfigSummary,
  provider: ProviderId,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): boolean {
  const source = sourceFor(config, provider, storage)
  if (source === 'official') return true
  if ((source !== 'account' && source !== 'manual' && !((source === 'unknown' || source === 'changed') && config.hasApiKey && config.matchesRelay)) || !config.model.trim()) return false
  return provider !== 'gemini' || config.authType === 'gemini-api-key'
}

/**
 * 账号还在恢复时读到的配置，没有账号可比，来源只可能判成 unknown——不是真的来源
 * 不明，更不是被改过。这一段时间里「用的是别处的配置」「配置被改过」都先不说，按
 * 连接本身能不能用显示，等恢复结束补读一次配置再下结论。只放过 sourceFor 里要看
 * 账号才判得了的那一支（Key 在、地址对得上当前中转）：地址指向别处的配置与账号
 * 无关，照常显示。
 */
export function ownershipAwaitingAccount(config: AppConfigSummary, tool: Pick<ToolPresentation, 'provider' | 'source'>): boolean {
  const provider = config.providers[tool.provider]
  return config.ownershipPending === true && (tool.source === 'unknown' || tool.source === 'changed')
    && provider.hasApiKey && provider.matchesRelay
}

export type CodexDesktopUpdateKind = 'latest' | 'installable' | 'store-current' | 'unknown'

/**
 * OpenAI's official MSIX feed can sit ahead of both the Microsoft Store
 * rollout and the domestic sideload mirror this app installs from, so
 * `updateAvailable` on its own does not mean anything can be installed.
 * After a Store update it reads as a stale nag on a row whose update button
 * has no package to fetch. Only a mirror build newer than the installed one
 * is actionable; an official version the mirror has not synced yet is
 * `store-current`, and a mirror probe that said nothing is `unknown`.
 */
export function codexDesktopUpdateKind(
  status: Pick<DesktopAppStatus, 'updateState' | 'mirrorUpdateAvailable'>,
): CodexDesktopUpdateKind {
  if (status.updateState === 'latest') return 'latest'
  if (status.updateState !== 'available') return 'unknown'
  if (status.mirrorUpdateAvailable === true) return 'installable'
  return status.mirrorUpdateAvailable === false ? 'store-current' : 'unknown'
}

export function presentTools(
  snapshot: ToolboxSnapshot,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): ToolPresentation[] {
  const result: ToolPresentation[] = []
  for (const definition of tools) {
    if (!isToolId(definition.id)) continue
    const id = definition.id
    if (id === 'codexDesktop' && !snapshot.platform.codexDesktop.launch) continue
    const provider = providerFor(id)
    const config = snapshot.config.providers[provider]
    const status = id === 'codexDesktop' ? snapshot.system.desktopApps.codex : snapshot.system.clis[id]
    const source = sourceFor(config, provider, storage)
    const version = id === 'codexDesktop' ? (status as DesktopAppStatus).appVersion ?? status.version : status.version
    // 桌面端走的是镜像分发而不是 npm,名单管不到它,所以这里只取 CLI 的建议。
    const versionAdvice = id === 'codexDesktop' ? null : snapshot.system.clis[id].versionAdvice ?? null
    const revertVersion = id === 'codexDesktop' ? null : snapshot.system.clis[id].revertVersion ?? null
    // 桌面端只有镜像真的有新包才算「可更新」;官方清单领先商店时按下「更新」什么也装不上。
    const updateAvailable = id === 'codexDesktop'
      ? codexDesktopUpdateKind(status as DesktopAppStatus) === 'installable'
      : status.updateAvailable === true
    result.push({ id, provider, name: definition.name, vendor: definition.vendor, status, source,
      model: config.model, configured: connectionReady(config, provider, storage),
      configDirectoryReady: config.dataDirectoryExists === true,
      updateAvailable, currentVersion: version,
      latestVersion: status.latestVersion ?? null, versionAdvice, revertVersion,
      error: status.detectionFailed ? snapshotErrorMessage(status.detectionError) ?? '工具检测没有完成' : null })
  }
  return result
}

/**
 * 工具行「…」菜单里「打开配置文件夹」那一项。点不动时置灰而不是藏起来:
 * 用户要找的就是这一项,藏了只会让人以为这个工具压根没有配置文件(「接着聊」
 * 在目录已经不在时也是置灰,#319)。原因写进 label,是因为菜单项没有 title 可挂。
 */
export function configDirectoryMenuItem(
  tool: Pick<ToolPresentation, 'configDirectoryReady'>,
  configUnavailable = false,
): { label: string; disabled: boolean } {
  // 配置整块没读到时目录状态也是不知道的,不能说成「还没生成」——它多半就在那儿,
  // 只是这一遍没读着。
  if (configUnavailable) return { label: '打开配置文件夹（配置暂未读到）', disabled: true }
  return tool.configDirectoryReady
    ? { label: '打开配置文件夹', disabled: false }
    : { label: '打开配置文件夹（还没生成）', disabled: true }
}

/**
 * 名单要把用户往哪个方向挪。撞上已知问题的用户往往要往前走到修复版
 * (Codex 0.155.0 → 0.155.1),跟着 npm latest 跑到推荐版本前面的用户才是
 * 真的退回来——同一个按钮,两个方向,一律写「回到」会把前一种指反。方向由
 * 主进程比过版本号后给出(recommendedIsNewer),渲染层不自己比。
 */
export function recommendedVersionVerb(tool: Pick<ToolPresentation, 'versionAdvice'>): string {
  return tool.versionAdvice?.recommendedIsNewer ? '更新到' : '回到'
}

/**
 * 工具行副标题里的版本文案。推荐版本与当前版本一致时不出现,避免每一行都
 * 挂一句用户不需要读的话。站点信息永远不出现在这里(双站点对用户无感)。
 * 推荐版本修了什么(recommendedNote)接在「推荐 x」后面:只写版本号时小白看
 * 不出这次更新和自己有没有关系,就一直不点。行太窄时靠样式截断,整句在悬停里。
 */
export function versionSubtitle(tool: Pick<ToolPresentation, 'currentVersion' | 'versionAdvice'>): string | undefined {
  if (!tool.currentVersion) return undefined
  const advice = tool.versionAdvice
  if (!advice || !advice.recommendedVersion || advice.onRecommended) return tool.currentVersion
  if (advice.blockedReason) return `${tool.currentVersion}（已知问题，建议${recommendedVersionVerb(tool)} ${advice.recommendedVersion}）`
  // 用户选了跟随最新版就别再劝他;有已知问题那一条上面已经先返回了。
  if (!advice.pinned) return tool.currentVersion
  return advice.recommendedNote
    ? `${tool.currentVersion}（推荐 ${advice.recommendedVersion}：${advice.recommendedNote}）`
    : `${tool.currentVersion}（推荐 ${advice.recommendedVersion}）`
}

/** 「更新」按钮的悬停说明:点下去会换到哪一版、修了什么。没写这句话时不给。 */
export function updateButtonHint(tool: Pick<ToolPresentation, 'versionAdvice'>): string | undefined {
  const advice = tool.versionAdvice
  if (!advice?.recommendedVersion || !advice.recommendedNote) return undefined
  return `更新到 ${advice.recommendedVersion}：${advice.recommendedNote}`
}

/** 可以一键切回推荐版本时给出那个版本号,否则 null。 */
export function rollbackVersion(tool: Pick<ToolPresentation, 'status' | 'versionAdvice'>): string | null {
  const advice = tool.versionAdvice
  return advice && tool.status.installed && advice.rollbackAvailable ? advice.recommendedVersion : null
}

/**
 * 「退回更新前的版本」要装回去的版本;不能退时 null。哪个版本、还在不在期限内、
 * 那个版本有没有已知问题都由主进程判过(cli-update-history.ts),这里只补两条
 * 界面上的规矩:没装着就无从退回;别的软件管着的安装不归本工具动。
 */
export function revertVersion(tool: Pick<ToolPresentation, 'status' | 'revertVersion'>): string | null {
  if (!tool.status.installed || !tool.revertVersion || isExternallyManagedInstall(tool.status)) return null
  return tool.revertVersion
}

/** 已经装好的工具，建议先换一个版本再用（新手引导「准备工具」那一步）。 */
export interface ToolUpdateOffer {
  /** 交给安装的版本；null = 跟首页「更新」一样不点名，由主进程按名单或最新版决定。 */
  version: string | null
  /** 换完是哪个版本，只用来上屏；说不准（桌面端走镜像）时为 null。 */
  target: string | null
  /** 目标版本比装着的新；false 只出现在当前版本有已知问题、推荐版本反而更旧的时候。 */
  newer: boolean
  /** 装着的版本落在名单的不兼容区间里。 */
  knownIssue: boolean
  /** 不是本工具装的：只给这句提示，不给按钮（与首页同一条规矩）。 */
  manualHint: string | null
}

/**
 * 引导以前只问「装没装」，找到任何版本都说「已经装好」（全面检测 Q50）：
 * 装着 2.1.42 的人一路走到打开工具，才发现和推荐的 2.1.277 差了一截。这里
 * 不另找版本来源，只读首页已经在用的两份判定——名单的建议（主进程比过
 * 版本号，recommendedIsNewer）和更新检查的 updateAvailable。
 *
 * 名单把安装钉在推荐版本上时，只有推荐版本更新才算旧：装着的比推荐还新时
 * 首页那颗「更新」其实会装回推荐版本，引导不该把这说成「版本旧了」。
 */
export function toolUpdateOffer(
  tool: Pick<ToolPresentation, 'id' | 'status' | 'updateAvailable' | 'latestVersion' | 'versionAdvice' | 'error'>,
): ToolUpdateOffer | null {
  if (!tool.status.installed || tool.error) return null
  const advice = tool.versionAdvice
  const knownIssue = Boolean(advice?.blockedReason)
  const recommended = rollbackVersion(tool)
  const manualHint = isExternallyManagedInstall(tool.status) ? externalInstallHint(tool.status.installSource) : null
  if (recommended && (advice?.recommendedIsNewer || knownIssue)) {
    return { version: recommended, target: recommended, newer: advice?.recommendedIsNewer === true, knownIssue, manualHint }
  }
  if (!tool.updateAvailable || (advice?.pinned && advice.recommendedVersion)) return null
  return { version: null, target: tool.id === 'codexDesktop' ? null : tool.latestVersion, newer: true, knownIssue, manualHint }
}

export function greeting(hour: number): string {
  return hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
}

export function balanceTier(dollars: number): 'ok' | 'warn' | 'bad' {
  return dollars < 5 ? 'bad' : dollars < 20 ? 'warn' : 'ok'
}

/**
 * 首页要不要把这一行当成「CC Switch 设置的」处理：主进程只给线索（装过 CC Switch，
 * 或配置里有它的代理接管占位），来源是不是已经确认要在这里看。当前账号写的、
 * 官方账号、手填的都不算，免得装过 CC Switch 的人每一行都挂黄牌。
 */
export function ccSwitchLeftoverFor(
  config: ProviderConfigSummary | undefined,
  provider: ProviderId,
  source: ToolSource,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): 'proxy' | 'provider' | null {
  if (!config?.ccSwitchLeftover || (source !== 'unknown' && source !== 'changed')) return null
  // 「就用现在这份」写的是同一个本机标记。地址指向别处的配置不会因此变成「手动」，
  // 所以在这里认它：认过之后回到原来那个中性的「用的是别处的配置」，不再挂黄牌。
  return readManualSourceMarker(storage, config.baseUrl, provider) ? null : config.ccSwitchLeftover
}
