import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as TOML from '@iarna/toml'
import { applyEdits, modify } from 'jsonc-parser'
import { providerBaseUrls, type ProviderId } from './catalog'
import { relayProviderBaseUrlEquals, relayProviderBaseUrlMatches, relaySiteEndpointIdForBaseUrl, relaySites } from './relay-sites'
import { readEnvLineValue, readJsonString, readTomlBoolean, readTomlString, rewriteEnvValue, rewriteJsonStrings, rewriteTomlStrings, rewriteTomlValues, type StringValueEdit, type ValueEdit } from './tool-route-rewrite'
import { readBoundedFileSync } from './bounded-file'
import { isCodexConfigBroken } from './codex-config-syntax'
import { isClaudeSettingsBroken, isCodexAuthBroken, isGeminiSettingsBroken } from './cli-config-health'
import { tomlErrorLocation } from './toml-error-location'
import { describeBrokenConfig, describeConfigReset } from './broken-config-advice'
import {
  defaultProviderConfigRoots,
  providerConfigRoot,
  type ProviderConfigRoots,
} from './codex-home'
import { identityFromCodexAuthTokens } from './official-account-identity'
import { removeCodexContextLimits } from './codex-context-limits'
import {
  assertSafeConfigPath,
  ensureRecord,
  executeFilePlans,
  fillableRecord,
  isJsonObject,
  isJsonRecord,
  jsonContent,
  MAX_NATIVE_CONFIG_BYTES,
  normalizeProviderConfigRoots,
  normalizeWorkspacePathKey,
  providerConfigPaths,
  readText,
  requireConfigText,
  requireRawConfigText,
  trustedFolderKey,
  withoutByteOrderMark,
} from './config-files-context'
import {
  applyGeminiRelayModelOverrides,
  buildGeminiRelayModelOverrides,
  disableGeminiRelayUsageStatistics,
  disableGeminiSelfUpdate,
  ensureGeminiContextFilenamesInSettingsText,
  ensureGeminiProjectContextFiles,
  extendGeminiSessionRetention,
  fillGeminiRelayTemplateDefaults,
  forgetStaleGeminiUsageStatisticsRecord,
  GEMINI_PROJECT_CONTEXT_FILENAMES,
  geminiCliCompatibleModel,
  geminiJsonContent,
  geminiTrustedFoldersTrustFolder,
  geminiUsageStatisticsRecordClearPlans,
  geminiUsageStatisticsRecordName,
  geminiUsageStatisticsRecordPlans,
  geminiUsageStatisticsSetting,
  geminiUsageStatisticsWrittenByUs,
  inspectRetiredGeminiIntegrations,
  MANAGED_GEMINI_SESSION_MAX_AGE,
  readGeminiJson,
  readGeminiUsageStatisticsRecord,
  removeGeminiRelayModelOverrides,
  removeRetiredGeminiIntegrations,
  requireGeminiJson,
  restoreGeminiUsageStatistics,
  trustGeminiWorkspace,
  trustGeminiWorkspaceInTrustedFoldersText,
} from './gemini-retired'
import { applyClaudeStatusLine, claudeStatusLineSetting, managedClaudeStatusLineTarget } from './claude-status-line'
import {
  applyClaudeCliHooks,
  applyCodexCliNotify,
  applyGeminiCliHooks,
  applyGrokCliHooks,
  grokCliHookCommand,
  removeClaudeCliHooks,
  removeCodexCliNotify,
  removeGeminiCliHooks,
  managedCliHookTargets,
  removeGrokCliHooks,
  type CliHookInvocation,
  type ManagedCliHookTarget,
} from './cli-hooks'
import { applyClaudeRelayModelPicker, claudeRelayModelPickerOutdated, claudeRelayModelPickerUpdates, removeClaudeRelayModelPicker } from './claude-model-picker'
import { projectInstructionsDigest } from './project-instructions'
import {
  applyCodexRelayModelCatalog,
  codexModelCatalogFileName,
  codexRelayModelCatalogOutdated,
  isManagedCodexModelCatalogSetting,
  removeCodexRelayModelCatalog,
} from './codex-model-catalog'
import {
  assertNoReparseComponents,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
} from './safe-local-data'
import {
  applyXingmangImageMcpToJson,
  applyXingmangImageMcpToToml,
  applyXingmangImagePermissionToClaudeSettings,
  repointXingmangImageMcpInToml,
  type XingmangImageMcpInvocation,
} from './xingmang-ai-mcp'

// ~/.claude.json 会随会话历史一起长，2MB 上限会误伤正常用户。
// 与 provider-extensions.ts 读同一份文件时用的上限保持一致。
const MAX_CLAUDE_ROOT_CONFIG_BYTES = 16 * 1024 * 1024

export interface NativeConfigFile {
  path: string
  exists: boolean
}

export interface NativeConfigInspection {
  baseUrl: string
  actualBaseUrl: string
  exists: boolean
  hasApiKey: boolean
  matchesRelay: boolean
  apiKey: string
  model: string
  /** Gemini CLI's persisted auth selector; absent for other providers. */
  authType?: string
  /** ChatGPT login email from Codex auth.json JWTs. Never the tokens themselves. */
  officialAccountEmail?: string | null
  /** ChatGPT plan label from the same JWTs, e.g. Pro 5x. */
  officialAccountPlan?: string | null
  /** ISO timestamp when the ChatGPT subscription is next active-until / renews. */
  officialAccountRenewsAt?: string | null
  /**
   * Codex auth.json `auth_mode`. Codex prefers this over the mere presence of
   * OPENAI_API_KEY, so a Xingmang key with chatgpt mode still uses ChatGPT.
   */
  codexAuthMode?: 'apikey' | 'chatgpt' | null
  /** Codex config.toml 的 `model_provider`（连接名）；只给 Codex，没写时为 null。 */
  codexProviderName?: string | null
  /**
   * 连接名是 Codex 内置的保留名（openai 等），而那张表写的又是已登记站点的地址：
   * Codex 会忽略这张表、按内置定义去连官方，带着当前账号的 Key 一跑就 401。
   * 独立成一个字段而不是改 matchesRelay：切回官方、删我们的表、启动门禁都靠
   * matchesRelay 认出「这是我们写的中转配置」，那部分判断必须照旧。
   */
  codexProviderShadowed?: boolean
  /**
   * 工具自己也读不了它的主配置（Codex 的 config.toml、Claude Code 与 Gemini CLI 的 settings.json；
   * 判定见 codex-config-syntax.ts、cli-config-health.ts）：Codex 桌面端停在「无法加载组织设置」、
   * 命令行报错，Claude Code 弹「Settings Error」整份不用，Gemini CLI 报错退出。这时读出来的 Key、
   * 地址都不作数，首页据此说「配置文件坏了」并给「修好它」。Grok 不判；缺省 = 没发现。
   */
  configBroken?: boolean
  /**
   * Codex 读不了 auth.json（判定见 cli-config-health.ts）。它不报错，当成没登录：打开就要重新
   * 登录。只给 Codex；缺省 = 没发现。
   */
  codexAuthBroken?: boolean
  /**
   * `grok login` 留在 ~/.grok/auth.json 里的 `auth_mode`（oidc = 浏览器登录，api_key =
   * 登录时填的 xAI Key）；null = 没登录。只读这一个字段，令牌与 Key 不读。
   */
  grokLoginMode?: string | null
  dataDirectory: string
  dataDirectoryExists: boolean
  files: NativeConfigFile[]
  updatedAt: string | null
}

/** Renderer-safe projection. The raw key never crosses the IPC boundary. */
export interface NativeConfigSummary extends Omit<NativeConfigInspection, 'apiKey'> {
  apiKeyPreview: string | null
  /** `changed` = 本程序替当前账号写过，之后被改动；判不准的仍是 `unknown`。 */
  configurationOwnership?: 'account' | 'manual' | 'unknown' | 'missing' | 'changed'
  /** Exact current-account cache match for display; never grants automatic write consent. */
  configurationAccountMatched?: boolean
  /**
   * 配置里那把是这家工具以前缓存过、后来换掉的托管 Key（换了分组、失效重签、分组被删）：上一轮换了 Key
   * 没写进配置。开机补写只认这一种（#1153）；客户在密钥页、配置窗口自己选的那把不会是它。缺省 = 不是。
   */
  configurationKeyReplaced?: boolean
  /**
   * 配置里实际写的是星芒账号（solov）的哪条线路（xm 三线路 C12）：按地址逐字比，落在退役别名上的、
   * 本站以外的地址都算 other。首页据此标「线路1 / 线路2 / 线路：其他地址」。只给星芒账号、只在配置
   * 里有地址时才有；缺省 = 不标（历史账号照旧不标）。
   */
  relayLine?: 'direct' | 'primary' | 'other'
  /**
   * 换线路时自动改写的状态（xm 三线路 C9、C10）：restart = 改了以后要重开才生效；managed-elsewhere
   * = 24 小时内被别的软件改回两次，星芒不再自动改它。缺省 = 没什么要说的。
   */
  relayRouteState?: 'restart' | 'managed-elsewhere'
  /**
   * 这份配置看起来是 CC Switch 写的（cc-switch-leftover.ts）：`proxy` = 它的本地代理
   * 接管占位，`provider` = 装过它且配置里有别处的连接。只是线索，不代表来源已确认，
   * 渲染层只在来源没确认或被改过时才用。缺省 = 没看出来。
   */
  ccSwitchLeftover?: 'proxy' | 'provider'
  /**
   * 本软件写进这份配置的钩子或状态行指向了不存在的程序、脚本，或不是这次安装带的那份
   * （卸载后换目录重装、挪了 app、换装了 Node.js）。首页据此给「修好它」。缺省 = 没发现。
   */
  cliHooksStale?: boolean
  /**
   * 只给 Windows 上的 Grok：钩子路径都对，但客户后来装了或卸了 Git、PowerShell 7，Grok 换了
   * 命令行，我们写下去的那种写法在新命令行里跑不起来。为真时 cliHooksStale 也为真，只多一句说明。
   */
  cliHooksShellChanged?: boolean
  /**
   * 只给 Windows 上的 Grok：配置是本软件写的，但做完提醒、防睡那几条钩子一条都没有——只装 Grok
   * 时电脑上还没有运行环境，钩子写不出来。首页据此说一句缺什么、给「补上」。缺省 = 不缺。
   */
  cliHooksMissing?: boolean
  /**
   * 这次打开软件时发现上面那种情况，已经替用户改好了（先备份再改，改完查过）。首页据此轻轻说一句。
   * 缺省 = 这次没自动改过。
   */
  cliHooksAutoRepaired?: boolean
}

export function apiKeyPreview(apiKey: string): string | null {
  const value = apiKey.trim()
  if (!value) return null
  if (value.length <= 9) return `${value.slice(0, Math.min(5, value.length))}...`
  return `${value.slice(0, 5)}${'•'.repeat(8)}${value.slice(-4)}`
}

export function toNativeConfigSummary(inspection: NativeConfigInspection): NativeConfigSummary {
  const { apiKey, ...safe } = inspection
  return { ...safe, apiKeyPreview: apiKeyPreview(apiKey) }
}

export interface NativeConfigSaveResult {
  backups: string[]
  files: string[]
}

export type CodexWorkspaceTrustLevel = 'trusted' | 'untrusted' | 'unknown'
export type CodexWorkspacePermissionControl = 'available' | 'restricted' | 'unknown'

/** Renderer-safe view of the Codex permission inputs that affect the Desktop picker. */
export interface CodexWorkspacePermissionStatus {
  configPath: string
  workspace: string
  configExists: boolean
  trustLevel: CodexWorkspaceTrustLevel
  approvalPolicy: string | null
  permissionProfile: string | null
  sandboxMode: string | null
  control: CodexWorkspacePermissionControl
  error: string | null
}

export interface CodexWorkspacePermissionWriteResult extends NativeConfigSaveResult {
  changed: boolean
  status: CodexWorkspacePermissionStatus
}

export type NativeConfigSaveMode = 'merge' | 'reset'

export interface NativeConfigWriteHooks {
  beforeReplace?: (targetPath: string, index: number) => void
}

export type FilePlan = FileWritePlan | FileRemovePlan

export interface FileWritePlan {
  path: string
  content: string
}

/**
 * 整份拿掉这个文件，不留空壳：Codex 把 `{}` 这样的 auth.json 当成没有令牌的 ChatGPT 登录，
 * 每次请求都报错，没登录只能是没有这个文件。和写入在同一次两阶段提交里：先留 .bak，再把它
 * 挪成临时文件，全部提交成功才清掉；中途失败照旧从 .bak 放回。不在的文件跳过。
 */
export interface FileRemovePlan {
  path: string
  remove: true
}

// 读写配置文件的底层（读文本、查路径、两阶段提交）搬进了 config-files-context.ts（#1070 第 10 步），这里照旧导出。
export { executeFilePlans, providerConfigPaths }

function readJson(filePath: string): Record<string, unknown> | null {
  const content = readText(filePath)
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

// 每个工具的主配置（providerConfigPaths 的第一份）它自己读不读得了；null = 不判。
const mainConfigBrokenChecks: Record<ProviderId, ((content: Buffer) => boolean) | null> = {
  codex: isCodexConfigBroken,
  claude: isClaudeSettingsBroken,
  gemini: isGeminiSettingsBroken,
  grok: null,
}

// 判断编码要看原始字节（解码会把坏字节悄悄换成 U+FFFD），读不到、不是单链接普通文件都当没坏。
function readFileBroken(filePath: string, broken: (content: Buffer) => boolean): boolean {
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) return false
    return broken(readBoundedFileSync(filePath, MAX_NATIVE_CONFIG_BYTES, '配置文件'))
  } catch {
    return false
  }
}

function readConfigFilesBroken(provider: ProviderId, paths: string[]): Pick<NativeConfigInspection, 'configBroken' | 'codexAuthBroken'> {
  const check = mainConfigBrokenChecks[provider]
  return {
    ...(check && readFileBroken(paths[0], check) ? { configBroken: true } : {}),
    ...(provider === 'codex' && readFileBroken(paths[1], isCodexAuthBroken) ? { codexAuthBroken: true } : {}),
  }
}

function readToml(filePath: string): Record<string, unknown> | null {
  const content = readText(filePath)
  if (!content) return null
  return parseTomlOrNull(content)
}

function parseTomlOrNull(content: string): Record<string, unknown> | null {
  try {
    return TOML.parse(content)
  } catch {
    return null
  }
}

// `brokenTool`：读不懂时指给客户去哪重置（broken-config-advice.ts），传首页那一行的工具名。只有保存、
// 写 Key（merge）那几处传；不传照旧报 label 那句，开机核对、画图登记这些多半只进日志（第三十批 C）。
function requireJson(filePath: string, label: string, brokenTool?: string): Record<string, unknown> {
  const content = requireConfigText(filePath, label)
  if (content === null) return {}
  try {
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Deliberately drop the parser's own message: V8's JSON.parse error
    // embeds a slice of the source around the failure, which for these config
    // files can carry the existing API key in the clear -- and this message
    // flows into the on-screen failure reason, the runtime log, and the
    // feedback export (I13). The label already names the file; the byte
    // offset does not help a non-technical user.
    throw new Error(brokenTool ? describeBrokenConfig(brokenTool) : `${label} 无法解析为 JSON，未执行修改`)
  }
  throw new Error(brokenTool ? describeBrokenConfig(brokenTool) : `${label} 不是有效的 JSON 对象，未执行修改`)
}

function requireToml(filePath: string, label: string, brokenTool?: string): Record<string, unknown> {
  const content = requireConfigText(filePath, label)
  if (content === null) return {}
  try {
    return TOML.parse(content)
  } catch (error) {
    throw new Error(brokenTool
      ? describeBrokenConfig(brokenTool, tomlErrorLocation(error))
      : `${label} 无法解析，未执行修改${tomlErrorLocation(error)}`)
  }
}

// 下线的 Gemini CLI 专用的那些搬进了 gemini-retired.ts（#1070 第 10 步），这里照旧导出。
export {
  ensureGeminiContextFilenamesInSettingsText,
  ensureGeminiProjectContextFiles,
  forgetStaleGeminiUsageStatisticsRecord,
  GEMINI_PROJECT_CONTEXT_FILENAMES,
  geminiCliCompatibleModel,
  geminiTrustedFoldersTrustFolder,
  geminiUsageStatisticsRecordName,
  inspectRetiredGeminiIntegrations,
  removeRetiredGeminiIntegrations,
  trustGeminiWorkspace,
  trustGeminiWorkspaceInTrustedFoldersText,
}
export type { RetiredGeminiIntegrations } from './gemini-retired'

// Claude Code 的 Artifact 工具只对 claude.ai 账号有用：它把结果发布成 claude.ai 上的
// 链接，走中转 API Key 的客户点开是空的。更要紧的是，2.1.265~2.1.268 那次「每轮请求
// 400」的载体正是这个工具——上游 2.1.268 的修复原文说，是它输入 schema 里的一段正则
// 被第三方 Anthropic 兼容端点拒绝。沙箱实测（2.1.277）确认 permissions.deny 是把工具
// 定义整条从请求体的 tools 里摘掉，而不是只拦执行，所以这条 deny 能挡住同一类 schema
// 故障，是版本名单之外的第二道保险。
//
// DesignSync 同理：它把设计稿同步到 claude.ai 的 Claude Design，要 claude.ai 登录才能用，
// 可 2.1.277 在中转上每一次请求都把它的定义发给模型（沙箱实测：deny 之后 tools 从 21 个
// 变 20 个）。模型会以为自己有这个能力，调了只会失败；它的 schema 也多一份要过中转校验。
const claudeDeniedRelayTools = ['Artifact', 'DesignSync']

/**
 * 把上面这几个工具追加进 permissions.deny（已有就不重复）。用户自己写的其他 deny 项与
 * permissions 下的其他键原样保留；deny 不是数组时按「缺省」处理，重建成数组。
 */
function denyClaudeRelayTool(permissions: Record<string, unknown>): void {
  const current = permissions.deny
  const existing = Array.isArray(current) ? current : []
  const missing = claudeDeniedRelayTools.filter((tool) => !existing.includes(tool))
  if (missing.length === 0) return
  permissions.deny = [...existing, ...missing]
}

/**
 * 切回官方 Claude 账号时只摘掉这几项：它们对 claude.ai 账号用户是有用的。其他 deny 项
 * 保留，deny 变空则连键一起删掉，避免留下空数组。
 */
function allowClaudeRelayTool(parsed: Record<string, unknown>): void {
  const permissions = parsed.permissions
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return
  const record = permissions as Record<string, unknown>
  const current = record.deny
  if (!Array.isArray(current)) return
  const kept = current.filter((entry) => !claudeDeniedRelayTools.includes(entry))
  if (kept.length === current.length) return
  if (kept.length === 0) delete record.deny
  else record.deny = kept
}

// Claude Code 的 WebFetch 每抓一个网页前，都先拿域名去问 api.anthropic.com 的
// /api/web/domain_info「这个站能不能抓」。国内连不上那台主机：被拒时工具立刻报
// 「Unable to verify if domain … is safe to fetch」，被静默丢包时先干等 30 秒再报同一句
// ——接中转的客户等于没有「读网页」。skipWebFetchPreflight 跳过这次询问，网页本身照常
// 抓取（沙箱实测 2.1.277：官方主机不可达时 1.2 秒抓到，且不再发 domain_info）。
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 管不到这一步，实测仍会预检。
//
// 代价是少了 Anthropic 那份域名黑名单。它只对连得上官方的用户有意义，所以与 Artifact
// 一样只在星芒来源下写，切回官方账号时撤掉。
function skipClaudeWebFetchPreflight(parsed: Record<string, unknown>): void {
  parsed.skipWebFetchPreflight = true
}

/**
 * 新客户的模板一直写「不逐条确认」。Claude Code 2.1.283 起接第三方中转、又没写
 * permissions.defaultMode 的会话进自动模式，有些命令会停下来问「允许吗」；先装过 Claude
 * Code 再接星芒的老客户走合并写入，以前没补这一项，升上去就会被问。没写才补，写过任何
 * 模式的一律不动（2026-10-06 yoyo 定）。skipDangerousModePermissionPrompt 一并补上，
 * 否则交互会话一打开先弹一屏英文的「绕过权限模式」确认。
 */
function skipClaudeCommandConfirmation(parsed: Record<string, unknown>, permissions: Record<string, unknown>): void {
  if (permissions.defaultMode === undefined) permissions.defaultMode = 'bypassPermissions'
  if (parsed.skipDangerousModePermissionPrompt === undefined) parsed.skipDangerousModePermissionPrompt = true
}

// 四个 CLI 各自带着更新机制，会绕过 cli-verified-versions.ts 钉住的推荐版本：Claude Code
// 在后台自更新，Gemini CLI 的 general.enableAutoUpdate 默认 true、启动就 npm install -g
// 最新版，Codex 与 Grok 启动时催更并给出 npm 命令。装到的版本一旦被 CLI 自己换掉，名单
// 就完全落空，客户可能第二天就跑在我们标了已知问题的版本上。安装与更新本来就归本软件
// （走 npm 官方源并对 SHA-512，首页有新版本时提醒），所以写配置时一并关掉各家自己的更新。
// 键名与沙箱实测结果记在 docs/CLI-VERIFIED-VERSIONS.md 的「CLI 自己的更新机制」一节。

/**
 * Claude Code 只认环境变量 DISABLE_AUTOUPDATER，settings.json 的 env 段就是上游给出的
 * 写法（2.1.277 实测：claude doctor 显示 "disabled (set by env: DISABLE_AUTOUPDATER)"）。
 * 刻意不用 DISABLE_UPDATES：那个连 `claude update` 也一起禁掉，而本软件的更新按钮之外，
 * 用户手动跑一次也应当照常。
 */
function disableClaudeSelfUpdate(env: Record<string, unknown>): void {
  env.DISABLE_AUTOUPDATER = '1'
}

/** Grok 的开关在 config.toml 的 [cli] 表里，等价环境变量是 GROK_DISABLE_AUTOUPDATER。 */
function disableGrokSelfUpdate(parsed: Record<string, unknown>): void {
  ensureRecord(parsed, 'cli').auto_update = false
}

// Grok CLI 的对话走 [model."grok"].base_url，但生成图片、改图、生成视频这几个工具另走
// endpoints.xai_api_base_url（默认 https://api.x.ai/v1），而且带的是同一把 api_key。
// 不改的话，用户一让它画图，中转 Key 就被发到 xAI 官方；国内连不上，还要卡 120 秒。
// 沙箱实测 1.0.40：改指中转后 /v1/images/generations 打到中转，0.5 秒返回，不再连
// api.x.ai。中转有没有对应的出图模型是另一回事，至少 Key 不外流、也不卡。
function pointGrokXaiApiAtRelay(parsed: Record<string, unknown>, relayBaseUrl: string): void {
  ensureRecord(parsed, 'endpoints').xai_api_base_url = relayBaseUrl
}

function addManagedGrokModel(parsed: Record<string, unknown>): void {
  const models = ensureRecord(parsed, 'models')
  models.default = 'grok'
  if (!nestedString(parsed, ['models', 'web_search'])) models.web_search = 'grok'
  const table = ensureRecord(ensureRecord(parsed, 'model'), 'grok')
  table.api_backend ??= 'responses'
  table.context_window ??= 1000000
  table.supports_backend_search ??= true
}

// Grok 1.0.40 的凭据顺序是 [model.X].api_key > ~/.grok/auth.json 的登录 > XAI_API_KEY。
// 切回官方必须把指向中转的整张模型表拿掉：只删 api_key、留着 base_url，Grok 会带着
// 官方登录的令牌去请求中转，等于把用户的 Grok 登录交给了第三方。出图工具走的
// endpoints.xai_api_base_url 同理。只动指向当前账号服务的那几项，用户自己加的别的
// 模型和设置原样留下。
function removeGrokRelayConfig(parsed: Record<string, unknown>, relayBaseUrl: string): void {
  const relay = normalizeUrl(relayBaseUrl)
  const removed = new Set<string>()
  const modelTables = parsed.model
  if (modelTables && typeof modelTables === 'object' && !Array.isArray(modelTables)) {
    const tables = modelTables as Record<string, unknown>
    for (const [name, table] of Object.entries(tables)) {
      if (!table || typeof table !== 'object' || Array.isArray(table)) continue
      const baseUrl = (table as Record<string, unknown>).base_url
      if (typeof baseUrl === 'string' && normalizeUrl(baseUrl) === relay) {
        delete tables[name]
        removed.add(name)
      }
    }
    if (Object.keys(tables).length === 0) delete parsed.model
  }
  const selectors = parsed.models
  if (selectors && typeof selectors === 'object' && !Array.isArray(selectors)) {
    const models = selectors as Record<string, unknown>
    for (const [key, value] of Object.entries(models)) {
      if (typeof value === 'string' && removed.has(value)) delete models[key]
    }
    // 接中转时 allowed_models 只留了中转那一项（pinGrokModelsToRelay）；表删了名单还在，
    // Grok 就一个可用型号都没有。
    if (Array.isArray(models.allowed_models)) {
      const allowed = models.allowed_models.filter((name) => typeof name !== 'string' || !removed.has(name))
      if (allowed.length === 0) delete models.allowed_models
      else models.allowed_models = allowed
    }
    if (Object.keys(models).length === 0) delete parsed.models
  }
  const endpoints = parsed.endpoints
  if (endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)) {
    const record = endpoints as Record<string, unknown>
    if (typeof record.xai_api_base_url === 'string' && normalizeUrl(record.xai_api_base_url) === relay) delete record.xai_api_base_url
    if (Object.keys(record).length === 0) delete parsed.endpoints
  }
}

// Grok CLI 自带一份内置型号目录（grok-4.6 / grok-4.5），它们走 xAI 自己的
// cli-chat-proxy.grok.com。接中转后这两项仍然出现在 /model 里，用户选了就一直
// 「Connection failed, Retrying」——国内连不上，而且本来也不该绕开当前账号。另外会话标题
// 与摘要（session_summary）默认钉在字面量 grok-4.6 上，经中转发出去；中转型号不叫这个
// 名字时标题就悄悄生成失败。
//
// 沙箱实测 1.0.40：allowed_models 只留中转那一项后，`grok models` 与 /model 只剩它；
// session_summary 指到它之后，标题、每轮小结、输入建议全部用中转型号。千万别用
// hidden_models / disabled_models：它们按 model 字段匹配，会连中转那一项一起藏掉，
// 结果一个可用型号都没有。image_description（看图转文字）同理指过去。
//
// 只在用户没写过时补，用户自己配了别的型号或名单就尊重他。
const grokRelayModelRoles = ['session_summary', 'image_description'] as const

function pinGrokModelsToRelay(parsed: Record<string, unknown>, relayModelName: string): void {
  const models = ensureRecord(parsed, 'models')
  if (models.allowed_models === undefined) models.allowed_models = [relayModelName]
  for (const role of grokRelayModelRoles) {
    if (models[role] === undefined) models[role] = relayModelName
  }
}

// Claude Code 与 Gemini CLI 都会自己删本机会话记录，默认都是 30 天，而记录页、首页
// 「最近」卡、「接着聊」、导出记录全都建立在那些文件还在的前提上——用户只会看到
// 「上个月那条对话不见了」。本软件替用户把保留期放长到一年。
//
// 沙箱实测（Claude Code 2.1.277 的 settings schema）：cleanupPeriodDays 是正整数、
// 最小 1、默认 30，描述原文「Number of days to retain chat transcripts before
// automatic cleanup (default: 30)… Use a large value for long retention」，所以
// 放长就是写一个大数，不能写 0。Gemini CLI 0.60.0 的 bundle 里 general.sessionRetention
// 的 enabled 默认 true、maxAge 默认 "30d"，且 getDefaultsFromSchema 会递归补齐嵌套
// 默认值——用户的 settings.json 里没有这一段，清理照样按 30 天跑。maxAge 的格式是
// /^(\d+)([dhwm])$/，"365d" 合法。
//
// 这两项是用户偏好，不是中转配置：用户自己设过就一字不动，切回官方账号也不收回。
const MANAGED_CLAUDE_RETENTION_DAYS = 365

/** 只在用户没写过 cleanupPeriodDays 时补上，写过什么值都原样保留。 */
function extendClaudeSessionRetention(parsed: Record<string, unknown>): void {
  if (parsed.cleanupPeriodDays !== undefined) return
  parsed.cleanupPeriodDays = MANAGED_CLAUDE_RETENTION_DAYS
}

// Claude Code 的 language 设置会被原样插进系统提示（2.1.277 实测：settings.json 写
// {"language":"简体中文"} 之后，请求体里出现「# Language\nAlways respond in 简体中文.」），
// 回复和会话标题都跟着变中文。本软件今天让 Claude 说中文靠的是 AGENTS.md 模板，而那份
// 模板只在目录里没有任何说明文件时才生成——从 GitHub 克隆来的项目基本都带 README，于是
// 还是英文。language 是用户级的，一次写好处处生效。
//
// 同样只在用户没设过时补，切回官方账号也不收回：这是语言偏好，与用哪个账号无关。
const MANAGED_CLAUDE_RESPONSE_LANGUAGE = '简体中文'

/** 只在用户没写过 language 时补上。 */
function ensureClaudeResponseLanguage(parsed: Record<string, unknown>): void {
  if (parsed.language !== undefined) return
  parsed.language = MANAGED_CLAUDE_RESPONSE_LANGUAGE
}

// Codex、Grok 没有 language 这样的设置，但都把自己配置目录里的一份全局说明拼在项目说明前面
// 交给模型。Codex 先认 AGENTS.override.md、再认 AGENTS.md（10-23 源码 codex-rs/codex-home/
// src/instructions/mod.rs）；Grok 1.0.70 自带的说明写着 ~/.grok/AGENTS.md 是「Global rules」，
// 同一目录下 AGENT.md、CLAUDE.md、CLAUDE.local.md 也认。项目说明模板只在目录里一份说明都没有
// 时才放，从网上拉下来的项目多半带英文 AGENTS.md，于是 Codex、Grok 照旧用英文回。
//
// 照 language 的做法当语言偏好：配置目录里这几个名字一个都没有（大小写不论，链接也算有）才放
// 这一份，客户已有的一个字不碰、不追加；切回官方账号也不收回。
export const MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS = [
  '# 回复语言',
  '',
  '- 始终用简体中文回复，包括计划、进度说明和最后的总结。',
  '- 代码、命令、文件路径和报错原文保持原样，不要翻译。',
  '',
  '<!-- 这份文件是星芒AI管理工具放的，对所有项目都生效。想换成别的语言，直接改上面两句；改过以后星芒不会再动它。 -->',
  '',
].join('\n')

/**
 * 发出去过的每一版全局说明的摘要（同 project-instructions.ts 的 projectInstructionsDigest），
 * 以后认得出客户手里那份还是不是星芒放的、改没改过。改上面的文字时把新版的摘要加在后面，
 * 旧的一个都不删。测试钉住当前这一版在表里。
 */
export const PUBLISHED_GLOBAL_RESPONSE_LANGUAGE_DIGESTS: readonly string[] = [
  // 2026-10-26 发出的第一版。
  '53fe08aa986a74ce1fd0f54c2c6a0835301591f426f10e895a0c3f7dce9f7270',
]

/**
 * 星芒替客户放过、这台电脑上出现过的几样（调用方按 app-settings.ts 的 seededToolDefaults 给这一家挑出来）。
 * 出现过、现在没有的是客户删的（或者恢复了一份更早的备份），不再补回（0.2.22 第二轮回归第 2、3 条）。
 * 缺省 = 都没出现过，照旧补。
 */
export interface SeededToolDefaults {
  /** Claude Code settings.json 的备用型号（fallbackModel）。 */
  claudeFallbackModel?: boolean
  /** Codex、Grok 配置目录里星芒放的那份「用中文回复」。 */
  responseLanguage?: boolean
}

const MAX_GLOBAL_RESPONSE_LANGUAGE_BYTES = 64 * 1024

/**
 * 这家工具配置目录里那份 AGENTS.md 是星芒放的、客户没改过的（摘要在 PUBLISHED_GLOBAL_RESPONSE_LANGUAGE_DIGESTS
 * 里）。没有、读不了、是链接、改过的一律算不是。只读。
 */
export function managedGlobalResponseLanguagePresent(provider: ProviderId, rootsInput: ProviderConfigRoots = defaultProviderConfigRoots()): boolean {
  if (!globalInstructionFileNames(provider).length) return false
  try {
    const roots = normalizeProviderConfigRoots(rootsInput)
    const content = readSafeUtf8FileSync(path.join(providerConfigRoot(provider, roots), 'AGENTS.md'), '工具全局说明', MAX_GLOBAL_RESPONSE_LANGUAGE_BYTES)
    return content !== null && PUBLISHED_GLOBAL_RESPONSE_LANGUAGE_DIGESTS.includes(projectInstructionsDigest(content))
  } catch {
    return false
  }
}

function globalInstructionFileNames(provider: ProviderId): readonly string[] {
  switch (provider) {
    case 'codex':
      return ['AGENTS.override.md', 'AGENTS.md']
    case 'grok':
      return ['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.local.md']
    case 'claude':
    case 'gemini':
      return []
  }
}

/**
 * 配置目录里一份全局说明都没有时放一份「用中文回复」；已经有了，或者目录读不了，就什么都不放。星芒放的那份
 * 在这台电脑上出现过的（seeded.responseLanguage）也不再放：现在没有就是客户删的。
 */
function globalResponseLanguagePlans(provider: ProviderId, roots: ProviderConfigRoots, seeded: SeededToolDefaults = {}): FilePlan[] {
  const names = globalInstructionFileNames(provider)
  if (!names.length || seeded.responseLanguage === true) return []
  const providerRoot = providerConfigRoot(provider, roots)
  let entries: string[] = []
  try {
    entries = fs.readdirSync(providerRoot)
  } catch (error) {
    // 目录还没有是第一次配置，照放；别的读不了宁可不放，不能为一句语言偏好挡住保存。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return []
  }
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  if (entries.some((entry) => wanted.has(entry.toLowerCase()))) return []
  return [{ path: path.join(providerRoot, 'AGENTS.md'), content: MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS }]
}

function nestedString(source: Record<string, unknown> | null, keys: string[]): string {
  let current: unknown = source
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return ''
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : ''
}

function readEnvValue(filePath: string, name: string): string {
  const content = readText(filePath)
  if (!content) return ''
  return readEnvLineValue(content, name) ?? ''
}

function readProviderApiKey(provider: ProviderId, paths: string[]): string {
  switch (provider) {
    case 'codex':
      return nestedString(readJson(paths[1]), ['OPENAI_API_KEY'])
    case 'claude':
      return nestedString(readJson(paths[0]), ['env', 'ANTHROPIC_AUTH_TOKEN'])
    case 'gemini':
      return readEnvValue(paths[1], 'GEMINI_API_KEY')
    case 'grok': {
      const parsed = readToml(paths[0])
      const defaultModel = nestedString(parsed, ['models', 'default'])
      return defaultModel ? nestedString(parsed, ['model', defaultModel, 'api_key']) : ''
    }
  }
}

function readProviderBaseUrl(provider: ProviderId, paths: string[]): string {
  switch (provider) {
    case 'codex': {
      const parsed = readToml(paths[0])
      const providerName = nestedString(parsed, ['model_provider'])
      return providerName
        ? nestedString(parsed, ['model_providers', providerName, 'base_url'])
        : ''
    }
    case 'claude':
      return nestedString(readJson(paths[0]), ['env', 'ANTHROPIC_BASE_URL'])
    case 'gemini':
      return readEnvValue(paths[1], 'GOOGLE_GEMINI_BASE_URL')
    case 'grok': {
      const parsed = readToml(paths[0])
      const defaultModel = nestedString(parsed, ['models', 'default'])
      return defaultModel ? nestedString(parsed, ['model', defaultModel, 'base_url']) : ''
    }
  }
}

function readProviderModel(provider: ProviderId, paths: string[]): string {
  switch (provider) {
    case 'codex':
      return nestedString(readToml(paths[0]), ['model'])
    case 'claude':
      return nestedString(readJson(paths[0]), ['model'])
    case 'gemini':
      return readEnvValue(paths[1], 'GEMINI_MODEL')
    case 'grok': {
      const parsed = readToml(paths[0])
      const defaultModel = nestedString(parsed, ['models', 'default'])
      return defaultModel ? nestedString(parsed, ['model', defaultModel, 'model']) : ''
    }
  }
}

function readProviderAuthType(provider: ProviderId, paths: string[]): string | undefined {
  return provider === 'gemini'
    ? nestedString(readGeminiJson(paths[0]), ['security', 'auth', 'selectedType'])
    : undefined
}

interface GrokLogin {
  mode: string
  email: string | null
}

// auth.json 按「签发方::客户端」分区，例如 `https://auth.x.ai::<uuid>`，每个分区里是
// key / refresh_token（机密，不碰）和 auth_mode、email 等说明字段。
function readGrokLogin(providerRoot: string): GrokLogin | null {
  const parsed = readJson(path.join(providerRoot, 'auth.json'))
  if (!parsed) return null
  for (const entry of Object.values(parsed)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.auth_mode !== 'string' || !record.auth_mode.trim()) continue
    return { mode: record.auth_mode.trim(), email: typeof record.email === 'string' && record.email.trim() ? record.email.trim() : null }
  }
  return null
}

function readOfficialAccountIdentity(provider: ProviderId, paths: string[]) {
  if (provider === 'grok') {
    return { email: readGrokLogin(path.dirname(paths[0]))?.email ?? null, planLabel: null, renewsAt: null }
  }
  if (provider !== 'codex') {
    return { email: null, planLabel: null, renewsAt: null }
  }
  const parsed = readJson(paths[1])
  return parsed
    ? identityFromCodexAuthTokens(parsed.tokens)
    : { email: null, planLabel: null, renewsAt: null }
}

export const codexChatGptAuthSnapshotName = 'xingmang-auth-chatgpt.json'
export const codexApiKeyAuthSnapshotName = 'xingmang-auth-apikey.json'
export const codexChatGptConfigSnapshotName = 'xingmang-config-chatgpt.toml'
export const codexRelayConfigSnapshotName = 'xingmang-config-relay.toml'

export function codexAuthSnapshotPaths(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): { active: string, chatgpt: string, apikey: string } {
  const root = providerConfigRoot('codex', normalizeProviderConfigRoots(rootsInput))
  return {
    active: path.join(root, 'auth.json'),
    chatgpt: path.join(root, codexChatGptAuthSnapshotName),
    apikey: path.join(root, codexApiKeyAuthSnapshotName),
  }
}

export function codexConfigSnapshotPaths(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): { active: string, chatgpt: string, relay: string } {
  const root = providerConfigRoot('codex', normalizeProviderConfigRoots(rootsInput))
  return {
    active: path.join(root, 'config.toml'),
    chatgpt: path.join(root, codexChatGptConfigSnapshotName),
    relay: path.join(root, codexRelayConfigSnapshotName),
  }
}

/** 本软件写的 Codex 型号名单，放在 config.toml 旁边（见 codex-model-catalog.ts）。 */
export function codexModelCatalogPath(rootsInput: ProviderConfigRoots = defaultProviderConfigRoots()): string {
  return path.join(providerConfigRoot('codex', normalizeProviderConfigRoots(rootsInput)), codexModelCatalogFileName)
}

/**
 * 名单文件的位置能不能写：还不存在、或是单链接普通文件才行。被换成符号链接、硬链接时
 * 不能经它写（I8），也不该让 Codex 经它读到我们核对不了的内容。
 */
export function codexModelCatalogTargetUsable(rootsInput: ProviderConfigRoots = defaultProviderConfigRoots()): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  try {
    assertSafeConfigPath(codexModelCatalogPath(roots), providerConfigRoot('codex', roots), 'file')
    return true
  } catch {
    return false
  }
}

export function classifyCodexConfigProfile(
  parsed: Record<string, unknown> | null,
  siteBaseUrl: string,
): 'relay' | 'official' | 'empty' {
  if (!parsed || Object.keys(parsed).length === 0) return 'empty'
  const providerName = typeof parsed.model_provider === 'string' ? parsed.model_provider.trim() : ''
  const providers = parsed.model_providers
  const entry = providerName && isJsonRecord(providers) ? providers[providerName] : null
  const baseUrl = isJsonRecord(entry) && typeof entry.base_url === 'string' ? entry.base_url : ''
  if (isKnownCodexRelayBaseUrl(baseUrl, siteBaseUrl)) return 'relay'
  return 'official'
}

function isKnownCodexRelayBaseUrl(baseUrl: string, siteBaseUrl: string): boolean {
  if (!baseUrl) return false
  return [siteBaseUrl, ...relaySites.map((site) => site.providerBaseUrls.codex)]
    .some((candidate) => relayProviderBaseUrlMatches('codex', baseUrl, candidate))
}

function cloneTomlRecord(parsed: Record<string, unknown>): Record<string, unknown> {
  return TOML.parse(TOML.stringify(parsed as Parameters<typeof TOML.stringify>[0]))
}

function withTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`
}

// 这三个顶层键是本软件早年写进 Codex config.toml 的，当前推荐版本（0.155.1）
// 已经不认：disable_response_storage 与 windows_wsl_setup_acknowledged 连同
// 它们背后的功能一起被删掉且没有替代；network_access 挪进了
// [sandbox_workspace_write] 表、类型从字符串变成布尔，语义也从「声明」变成
// 「放开沙箱里命令的联网」——顶层那一行从来没生效过，所以这里只删不搬，搬过去
// 等于替用户放宽沙箱。留着它们的唯一效果就是 Codex 启动时报「忽略了 N 个无法
// 识别的配置项」。
const deprecatedCodexConfigKeys: ReadonlyArray<readonly [string, unknown]> = [
  ['disable_response_storage', true],
  ['network_access', 'enabled'],
  ['windows_wsl_setup_acknowledged', true],
]

/**
 * 清掉我们自己留下的废弃键。只认「键名和值都与当年模板一致」的那一份，用户把值
 * 改成别的就当成他自己的设置不动；嵌套表里的同名键（sandbox_workspace_write.
 * network_access）也不受影响，这里只看顶层。
 */
function dropDeprecatedCodexConfigKeys(parsed: Record<string, unknown>): void {
  for (const [key, writtenValue] of deprecatedCodexConfigKeys) {
    if (parsed[key] === writtenValue) delete parsed[key]
  }
}

// Codex 默认把使用统计（OTEL 指标）发去 ab.chatgpt.com，`codex exec` 退出前还要等它发完。
// 国内连不上时这一等就是 10 秒左右——每跑一次都卡（沙箱实测 0.155.1：官方主机被丢包时
// 10.28 秒，关掉后 0.24 秒）。统计只给 OpenAI 自己看，关掉没有任何功能损失。app-server
// （Codex 桌面端）用同一个开关。只在用户没表过态时补，用户写了 true 就尊重他。
function disableCodexRelayAnalytics(parsed: Record<string, unknown>): void {
  const analytics = ensureRecord(parsed, 'analytics')
  if (analytics.enabled === undefined) analytics.enabled = false
}

// Codex 桌面端左上角选成「ChatGPT Work」，config.toml 的 [desktop] 里记的是
// conversationDetailMode = "STEPS_PROSE"。这个模式开着内置浏览器、又没登录 ChatGPT 账号时，开新对话
// 就在本机报「Work browser access requires an authenticated account」，消息根本没发出去；用密钥接入的
// 客户全都没登录。客户端要先从 OpenAI 的开关服务读到账号的工作模式策略才查这一项，读没读到看网络，
// 所以客户看到的是时好时坏（#1353，按 Windows 版 26.1013.4894 的程序核对）。只把这一个值换回 Codex
// 模式的缺省 STEPS_COMMANDS：没写这个键、写的是另一档 Codex 模式（STEPS_EXECUTION）都不动，
// 官方账号那份不经过这里。
//
// 只在保存配置时换，不进开机补设置（fillCodexRelayTemplateDefaults）：这是客户自己选的值，
// 开机补完那句提示说的是「自己改过的设置都没动」。
function leaveCodexDesktopChatGptWorkMode(parsed: Record<string, unknown>): void {
  const desktop = parsed.desktop
  if (isJsonRecord(desktop) && desktop.conversationDetailMode === 'STEPS_PROSE') {
    desktop.conversationDetailMode = 'STEPS_COMMANDS'
  }
}

/** 切回 ChatGPT 时只收回本软件写的那一份：整张表恰好就是 `enabled = false`。 */
function restoreCodexAnalytics(parsed: Record<string, unknown>): void {
  const analytics = parsed.analytics
  if (isJsonRecord(analytics) && Object.keys(analytics).length === 1 && analytics.enabled === false) {
    delete parsed.analytics
  }
}

// Windows 上 Codex 真正决定「怎么隔离命令」的是 [windows] sandbox，缺省时第一次让 AI
// 跑命令会弹英文的沙箱设置，选推荐那档还要过一次管理员确认（上游 #40627 / #23712 /
// #24098 都是反复弹、设置失败）。unelevated 用当前用户权限建沙箱，不弹管理员框；
// sandbox_mode = "workspace-write" 照旧，所以不是放宽，只是不需要提权。Mac 没有这张表。
//
// prevent_idle_sleep 是 0.156.1 的实验开关：只在 Codex 正在跑一轮时不让电脑自动睡，
// 跑完就放开，屏幕照样会关。笔记本跑长任务睡着了，连接断掉这一轮就白扣了。
//
// daemon_auto_start 在 0.157.0 转成默认开：客户在自己终端敲 codex 也会拉起一个多窗口
// 共享用的后台服务，退出 Codex 后它还留着（rust-v0.158.0 app-server-daemon 里没有
// 空闲自动退出），低配电脑上是一份没人要的常驻开销。关掉它不影响 `codex agents`，
// 那条命令自己会按需拉起服务（cli/src/main.rs）。0.155.x 及更早不认这个键，只在
// 日志里记一行 unknown feature key，不影响启动（features/src/lib.rs）。
//
// 三项都只在键缺省时写，用户写过（哪怕写成 false 或 elevated）一律不动；键名以
// rust-v0.156.1 的 core/config.schema.json 为准。
export function applyCodexRelayMachineDefaults(
  parsed: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): void {
  const features = parsed.features === undefined ? ensureRecord(parsed, 'features') : parsed.features
  if (isJsonRecord(features) && features.prevent_idle_sleep === undefined) {
    features.prevent_idle_sleep = true
  }
  if (isJsonRecord(features) && features.daemon_auto_start === undefined) {
    features.daemon_auto_start = false
  }
  if (platform !== 'win32') return
  const windows = parsed.windows === undefined ? ensureRecord(parsed, 'windows') : parsed.windows
  if (isJsonRecord(windows) && windows.sandbox === undefined) windows.sandbox = 'unelevated'
}

/**
 * Codex 的后台服务开没开（xm 三线路 C16）。本软件打开 Codex 时带 --no-daemon，这一项只管
 * 客户自己在终端里敲 codex：开着时，换线路后半小时内接着聊的旧对话可能还留在后台那份里、
 * 走原来的地址（#941 第 6 节）。'default' = 两处都没写，0.157.0 起缺省是开。
 *
 * 照 rust-v0.160.1 features/src/lib.rs（0.162.1 同）：先看 [features]，再看顶层 profile
 * 选中的 [profiles.<名>.features]，后者盖过前者；不是 true / false 的值 Codex 根本读不进来，
 * 当没写。
 */
export type CodexDaemonAutoStart = 'on' | 'off' | 'default'

export function codexDaemonAutoStartSetting(parsed: Record<string, unknown>): CodexDaemonAutoStart {
  const profileName = typeof parsed.profile === 'string' ? parsed.profile : ''
  const profiles = isJsonRecord(parsed.profiles) ? parsed.profiles : {}
  const profile = profileName && isJsonRecord(profiles[profileName]) ? profiles[profileName] : {}
  let setting: CodexDaemonAutoStart = 'default'
  for (const features of [parsed.features, profile.features]) {
    if (isJsonRecord(features) && typeof features.daemon_auto_start === 'boolean') {
      setting = features.daemon_auto_start ? 'on' : 'off'
    }
  }
  return setting
}

/** 只读不改；没有这份配置、读不了或读不懂时是 null，配置坏没坏由 Codex 那一项自己去说。 */
export function inspectCodexDaemonAutoStart(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): CodexDaemonAutoStart | null {
  const configPath = codexConfigSnapshotPaths(normalizeProviderConfigRoots(rootsInput)).active
  try {
    const content = readTrustConfigText(configPath, path.dirname(configPath), '现有 Codex config.toml')
    return content === null ? null : codexDaemonAutoStartSetting(TOML.parse(content))
  } catch {
    return null
  }
}

function stripCodexRelayFromConfig(
  parsed: Record<string, unknown>,
  siteBaseUrl: string,
): void {
  const providerName = typeof parsed.model_provider === 'string' ? parsed.model_provider.trim() : ''
  const providers = parsed.model_providers
  if (providerName && isJsonRecord(providers)) {
    const entry = providers[providerName]
    const entryBaseUrl = isJsonRecord(entry) && typeof entry.base_url === 'string' ? entry.base_url : ''
    if (isKnownCodexRelayBaseUrl(entryBaseUrl, siteBaseUrl)) {
      delete providers[providerName]
    }
    if (Object.keys(providers).length === 0) delete parsed.model_providers
  }
  delete parsed.model_provider
  delete parsed.model
  delete parsed.review_model
  removeCodexRelayModelCatalog(parsed)
  removeCodexCliNotify(parsed)
  restoreCodexAnalytics(parsed)
  dropDeprecatedCodexConfigKeys(parsed)
}

function applyCodexRelayConfig(
  parsed: Record<string, unknown>,
  model: string,
  providerName: string,
  siteBaseUrl: string,
): void {
  migrateOwnReservedCodexProvider(parsed, providerName, siteBaseUrl)
  const previousModel = parsed.model
  parsed.model = model
  parsed.review_model = model
  parsed.model_provider = providerName
  parsed.check_for_update_on_startup = false
  disableCodexRelayAnalytics(parsed)
  dropDeprecatedCodexConfigKeys(parsed)
  leaveCodexDesktopChatGptWorkMode(parsed)
  const providerEntry = ensureRecord(ensureRecord(parsed, 'model_providers'), providerName)
  // Before base_url is overwritten: only a table that already points at our relay is ours to rename.
  renameLegacyCodexRelayDisplayName(providerEntry, siteBaseUrl)
  providerEntry.name = typeof providerEntry.name === 'string' && providerEntry.name.trim()
    ? providerEntry.name
    : codexRelayDisplayName
  providerEntry.base_url = siteBaseUrl
  // Current Codex accepts only Responses, including for custom model providers.
  // Model names alone cannot establish the relay's protocol compatibility.
  providerEntry.wire_api = 'responses'
  providerEntry.requires_openai_auth = true
  followCodexRelayWebsockets(providerEntry, previousModel, model)
  // Keep the Desktop permission picker interactive on fresh mirror installs.
  // Never override an explicit user policy such as `never`.
  if (parsed.approval_policy === undefined) parsed.approval_policy = 'on-request'
  if (parsed.sandbox_mode === undefined) parsed.sandbox_mode = 'workspace-write'
  applyCodexRelayMachineDefaults(parsed)
  // With `keyring` or `auto`, Codex reads the OS credential store before
  // auth.json (login/src/auth/storage.rs), so a ChatGPT login kept there would
  // keep winning over the relay key written below and reach the relay as a
  // bearer token. The official profile keeps its own value in its snapshot.
  if (parsed.cli_auth_credentials_store !== undefined && parsed.cli_auth_credentials_store !== 'file') {
    parsed.cli_auth_credentials_store = 'file'
  }
  allowCodexApiKeyLogin(parsed)
}

// 公司统一下发的配置里常写 forced_login_method = "chatgpt"。Codex 一启动就核登录方式：auth.json 里是
// 密钥就当场删掉它、要求登 ChatGPT（0.164.0 连本机假接口实测，报「ChatGPT login is required, but an API
// key is currently being used. Logging out.」后退出），首页却还显示配好了（D04）。用当前账号时只拿掉这一条；写的是 "api" 跟密钥接入不冲突，不动。官方快照里照留
// 原值，切回官方账号时原样回来，跟上面的 cli_auth_credentials_store 一样。
//
// 只在保存配置时拿掉，不进开机补设置（fillCodexRelayTemplateDefaults）：这是客户自己写的值。
function allowCodexApiKeyLogin(parsed: Record<string, unknown>): void {
  if (typeof parsed.forced_login_method === 'string' && parsed.forced_login_method.trim().toLowerCase() === 'chatgpt') {
    delete parsed.forced_login_method
  }
}

function buildCodexRelayConfigTemplate(
  model: string,
  providerName: string,
  siteBaseUrl: string,
  cliHook?: CliHookInvocation,
  withModelCatalog = false,
  platform: NodeJS.Platform = process.platform,
): string {
  const providerKey = tomlTableKey(providerName)
  // Same argv as applyCodexCliNotify. It must stay above the first table.
  const notifyLine = cliHook
    ? [`notify = [${[cliHook.nodeExecutable, cliHook.scriptPath, 'codex', cliHook.eventsDirectory].map(tomlString).join(', ')}]`]
    : []
  // Codex only honours this key above the first table; a relative name resolves
  // next to config.toml, which also keeps Windows paths out of TOML escaping.
  const catalogLine = withModelCatalog ? [`model_catalog_json = ${tomlString(codexModelCatalogFileName)}`] : []
  // Same values as applyCodexRelayMachineDefaults; the template is spelled out
  // so a fresh install reads top to bottom like the upstream docs.
  const windowsTable = platform === 'win32' ? ['[windows]', 'sandbox = "unelevated"', ''] : []
  return [
    `model_provider = ${tomlString(providerName)}`,
    `model = ${tomlString(model)}`,
    `review_model = ${tomlString(model)}`,
    'model_reasoning_effort = "xhigh"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'check_for_update_on_startup = false',
    ...catalogLine,
    ...notifyLine,
    '',
    `[model_providers.${providerKey}]`,
    `name = ${tomlString(codexRelayDisplayName)}`,
    `base_url = ${tomlString(siteBaseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    `supports_websockets = ${codexModelUsesRelayWebsockets(model)}`,
    '',
    '[features]',
    'goals = true',
    'prevent_idle_sleep = true',
    'daemon_auto_start = false',
    '',
    ...windowsTable,
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n')
}

function snapshotOfficialCodexConfigText(
  currentText: string,
  currentParsed: Record<string, unknown>,
  siteBaseUrl: string,
): string {
  if (classifyCodexConfigProfile(currentParsed, siteBaseUrl) === 'official') {
    if (!isManagedCodexModelCatalogSetting(currentParsed.model_catalog_json)) return withTrailingNewline(currentText)
    // 我们那份型号名单会整份顶掉 ChatGPT 登录时服务器下发的名单，官方快照里不能留着指向
    // 它的那一行。只摘这一行，用户自己的官方设置一个不动。
    const official = cloneTomlRecord(currentParsed)
    removeCodexRelayModelCatalog(official)
    return tomlContent(official)
  }
  const cleaned = cloneTomlRecord(currentParsed)
  stripCodexRelayFromConfig(cleaned, siteBaseUrl)
  return tomlContent(cleaned)
}

function readStoredCodexConfig(filePath: string, label: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const text = requireConfigText(filePath, label)
  if (!text || !text.trim()) return null
  try {
    TOML.parse(text)
  } catch {
    // 只在 merge 时读它（切回当前账号要用这份），读不懂就指去重置（第三十批 C）。
    throw new Error(describeConfigReset('Codex', '星芒替 Codex 存的那份配置读不出来了'))
  }
  return withTrailingNewline(text)
}

function createCodexRelayConfigPlans(
  model: string,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
  mode: NativeConfigSaveMode,
  cliHook?: CliHookInvocation,
  // 本软件管的型号名单（codex-model-catalog.ts）：字符串 = 写这份文件并指向它；null = 收回
  // 本软件写的那一行；缺省 = 那一行和文件都原样不动，与从前一致。
  modelCatalog?: string | null,
): FilePlan[] {
  const paths = codexConfigSnapshotPaths(roots)
  const plans: FilePlan[] = []
  // 名单文件被换成了链接：这次只收回那一行，Key 和其余配置照常保存，不让一个写不了的
  // 附属文件把整次保存连累失败。
  const catalog = typeof modelCatalog === 'string' && !codexModelCatalogTargetUsable(roots) ? null : modelCatalog
  const currentText = fs.existsSync(paths.active)
    ? requireConfigText(paths.active, '现有 Codex config.toml')
    : null
  let currentParsed: Record<string, unknown> | null = null
  if (currentText) {
    try {
      currentParsed = TOML.parse(currentText)
    } catch (error) {
      if (mode !== 'reset') {
        // Codex CLI 和 Codex 桌面端共用这一份，句子里只叫「Codex」（第三十批 C）。
        throw new Error(describeBrokenConfig('Codex', tomlErrorLocation(error)))
      }
    }
  }
  const currentKind = classifyCodexConfigProfile(currentParsed, siteBaseUrls.codex)
  if (currentText && currentParsed && (currentKind === 'official' || !fs.existsSync(paths.chatgpt))) {
    plans.push({
      path: paths.chatgpt,
      content: snapshotOfficialCodexConfigText(currentText, currentParsed, siteBaseUrls.codex),
    })
  }

  const storedRelay = mode === 'merge' && currentKind === 'official'
    ? readStoredCodexConfig(paths.relay, '已保存的星芒 Codex 配置') : null
  const templateCatalog = typeof catalog === 'string'
  let catalogInUse = false
  let nextContent: string
  if (mode === 'reset') {
    catalogInUse = templateCatalog
    nextContent = buildCodexRelayConfigTemplate(model, existingCodexProvider(paths.active, siteBaseUrls.codex), siteBaseUrls.codex, cliHook, templateCatalog)
  } else if (storedRelay) {
    const stored = TOML.parse(storedRelay)
    applyCodexRelayConfig(stored, model, codexRelayProviderFor(stored, siteBaseUrls.codex, true), siteBaseUrls.codex)
    if (cliHook) applyCodexCliNotify(stored, cliHook)
    if (catalog !== undefined) catalogInUse = applyCodexRelayModelCatalog(stored, templateCatalog)
    nextContent = tomlContent(stored)
  } else if (currentParsed) {
    applyCodexRelayConfig(currentParsed, model, codexRelayProviderFor(currentParsed, siteBaseUrls.codex, true), siteBaseUrls.codex)
    if (cliHook) applyCodexCliNotify(currentParsed, cliHook)
    if (catalog !== undefined) catalogInUse = applyCodexRelayModelCatalog(currentParsed, templateCatalog)
    nextContent = tomlContent(currentParsed)
  } else {
    catalogInUse = templateCatalog
    nextContent = buildCodexRelayConfigTemplate(model, defaultCodexRelayProvider, siteBaseUrls.codex, cliHook, templateCatalog)
  }

  // Codex refuses to start when model_catalog_json names a missing file, so the
  // catalog is committed before the config that points at it: a crash between
  // the renames leaves an unused file, never a dangling setting. An unchanged
  // file is not rewritten, which also keeps every save from adding a backup.
  if (catalogInUse && typeof catalog === 'string') {
    const catalogPath = codexModelCatalogPath(roots)
    if (readText(catalogPath) !== catalog) plans.unshift({ path: catalogPath, content: catalog })
  }
  plans.push({ path: paths.relay, content: nextContent })
  plans.push({ path: paths.active, content: nextContent })
  return plans
}

function createCodexOfficialConfigPlans(
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
  mode: NativeConfigSaveMode,
): FilePlan[] {
  const paths = codexConfigSnapshotPaths(roots)
  const plans: FilePlan[] = []
  const currentText = fs.existsSync(paths.active)
    ? requireConfigText(paths.active, '现有 Codex config.toml')
    : null
  // 重置是读不懂的配置唯一的出路（首页「配置文件坏了」的「修好它」也走这里），登录 ChatGPT 的
  // 客户也一样：坏文件照旧先备份再整份换掉。只更新（merge）仍然拒绝，不悄悄重置客户的设置。
  const currentParsed = !currentText ? null
    : mode === 'reset' ? parseTomlOrNull(currentText)
      : requireToml(paths.active, '现有 Codex config.toml')
  if (currentText && classifyCodexConfigProfile(currentParsed, siteBaseUrls.codex) === 'relay') {
    plans.push({ path: paths.relay, content: withTrailingNewline(currentText) })
  }
  // 用当前账号聊过的旧对话记着这张表的名字，官方配置里得留一张同名走官方登录的（见 officialCodexAliasEntry）。
  // 已经在官方账号上重置时，名字从星芒存的那份当前账号配置里找。
  const relayProviderName = activeCodexRelayProviderName(currentParsed, siteBaseUrls.codex)
    ?? activeCodexRelayProviderName(readStoredCodexRelayConfigOrNull(paths.relay), siteBaseUrls.codex)
  function officialContent(text: string): string {
    return withOfficialCodexAlias(text, relayProviderName, siteBaseUrls.codex)
  }
  if (mode === 'reset') {
    // Reset only the selected account source. Replacing its snapshot too keeps
    // an old official customization from returning after a relay round trip.
    const initial = 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\ncheck_for_update_on_startup = false\n'
    plans.push({ path: paths.chatgpt, content: initial })
    plans.push({ path: paths.active, content: officialContent(initial) })
    return plans
  }
  if (!currentParsed) return plans
  const storedChatgpt = readStoredCodexConfig(paths.chatgpt, '已保存的 ChatGPT Codex 配置')
  if (storedChatgpt && classifyCodexConfigProfile(TOML.parse(storedChatgpt), siteBaseUrls.codex) === 'official') {
    plans.push({ path: paths.active, content: officialContent(storedChatgpt) })
    return plans
  }
  const cleaned = cloneTomlRecord(currentParsed)
  stripCodexRelayFromConfig(cleaned, siteBaseUrls.codex)
  const cleanContent = tomlContent(cleaned)
  // Older versions could have stored another Xingmang site as the official
  // snapshot. Replace that polluted copy in the same file transaction.
  if (storedChatgpt) plans.push({ path: paths.chatgpt, content: cleanContent })
  plans.push({ path: paths.active, content: officialContent(cleanContent) })
  return plans
}

export function classifyCodexAuthProfile(value: unknown): 'apikey' | 'chatgpt' | 'mixed' | 'empty' {
  if (!isJsonRecord(value)) return 'empty'
  const hasKey = typeof value.OPENAI_API_KEY === 'string' && value.OPENAI_API_KEY.trim().length > 0
  const tokens = value.tokens
  const hasTokens = isJsonRecord(tokens)
    && typeof tokens.id_token === 'string'
    && tokens.id_token.length > 0
    && typeof tokens.access_token === 'string'
    && tokens.access_token.length > 0
  if (hasKey && hasTokens) return 'mixed'
  if (hasKey) return 'apikey'
  if (hasTokens) return 'chatgpt'
  return 'empty'
}

/** 星芒中转用的 auth.json：只有 OPENAI_API_KEY，不带 ChatGPT tokens。 */
export function buildCodexApiKeyAuth(apiKey: string): { OPENAI_API_KEY: string } {
  return { OPENAI_API_KEY: apiKey }
}

/**
 * 抽出可整份换回的 ChatGPT 登录。tokens 原样保留，不掺 OPENAI_API_KEY。
 * 缺登录态则返回 null，避免用空对象盖掉已经存好的快照。
 */
export function snapshotCodexChatGptAuth(value: unknown): Record<string, unknown> | null {
  if (!isJsonRecord(value) || !isJsonRecord(value.tokens)) return null
  const tokens = value.tokens
  if (typeof tokens.id_token !== 'string' || !tokens.id_token) return null
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) return null
  const snapshot: Record<string, unknown> = {
    auth_mode: 'chatgpt',
    tokens,
  }
  if (typeof value.last_refresh === 'string' && value.last_refresh) {
    snapshot.last_refresh = value.last_refresh
  }
  return snapshot
}

/**
 * 读现有的 auth.json，好把里面的 ChatGPT 登录、Key 存进快照再换掉它。只更新（merge）读不懂就停，
 * 指去重置；重置时读不懂不挡路（读不懂返回 null）：Codex 自己也读不了这样的文件，当成没登录，
 * 里面没有它还认得的登录可留。换掉之前照旧先备份。
 */
function readCodexAuthForSave(filePath: string, mode: NativeConfigSaveMode): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null
  if (mode === 'merge') return requireJson(filePath, '现有 Codex auth.json', 'Codex')
  const content = requireConfigText(filePath, '现有 Codex auth.json')
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as unknown
    return isJsonRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function createCodexRelayAuthPlans(apiKey: string, roots: ProviderConfigRoots, mode: NativeConfigSaveMode): FilePlan[] {
  const paths = codexAuthSnapshotPaths(roots)
  const plans: FilePlan[] = []
  const chatgpt = snapshotCodexChatGptAuth(readCodexAuthForSave(paths.active, mode))
  if (chatgpt) plans.push({ path: paths.chatgpt, content: jsonContent(chatgpt) })
  const apikeyAuth = buildCodexApiKeyAuth(apiKey)
  plans.push({ path: paths.apikey, content: jsonContent(apikeyAuth) })
  plans.push({ path: paths.active, content: jsonContent(apikeyAuth) })
  return plans
}

// 拿掉 Key 和 auth_mode 之后只剩这些（或什么都不剩）时，留下的不是一份登录：Codex 0.159 把没写
// auth_mode、又没有 Key 的 auth.json 当成 ChatGPT 登录，没有令牌就每次请求都报「plan type is
// required for chatgpt authentication」，桌面端多半停在「无法加载组织设置」，也不会叫人重新登录。
const codexAuthLeftovers: ReadonlySet<string> = new Set(['tokens', 'last_refresh'])

function createCodexOfficialAuthPlans(roots: ProviderConfigRoots, mode: NativeConfigSaveMode): FilePlan[] {
  const paths = codexAuthSnapshotPaths(roots)
  const current = readCodexAuthForSave(paths.active, mode)
  const plans: FilePlan[] = []
  const currentKey = typeof current?.OPENAI_API_KEY === 'string' ? current.OPENAI_API_KEY.trim() : ''
  if (currentKey) {
    plans.push({ path: paths.apikey, content: jsonContent(buildCodexApiKeyAuth(currentKey)) })
  }
  const chatgptFromCurrent = snapshotCodexChatGptAuth(current)
  if (chatgptFromCurrent) {
    plans.push({ path: paths.chatgpt, content: jsonContent(chatgptFromCurrent) })
  }
  const chatgptToRestore = chatgptFromCurrent ?? snapshotCodexChatGptAuth(readJson(paths.chatgpt))
  if (chatgptToRestore) {
    plans.push({ path: paths.active, content: jsonContent(chatgptToRestore) })
    return plans
  }
  if (current) {
    delete current.OPENAI_API_KEY
    delete current.auth_mode
    if (Object.keys(current).some((key) => !codexAuthLeftovers.has(key))) {
      plans.push({ path: paths.active, content: jsonContent(current) })
      return plans
    }
  }
  // 没有可换回的 ChatGPT 登录：和 Codex 自己退出登录一样不留这个文件，打开时它会叫人登录。
  // 重置时读不懂的那份也走这里（readCodexAuthForSave 读成 null）。
  if (current || mode === 'reset') plans.push({ path: paths.active, remove: true })
  return plans
}

function readCodexProviderSelection(
  paths: string[],
  siteBaseUrl: string,
): Pick<NativeConfigInspection, 'codexProviderName' | 'codexProviderShadowed'> {
  const parsed = readToml(paths[0])
  const name = nestedString(parsed, ['model_provider']).trim()
  if (!parsed || !name) return { codexProviderName: null, codexProviderShadowed: false }
  const providers = parsed.model_providers
  const entry = isJsonRecord(providers) ? providers[name] : null
  return {
    codexProviderName: name,
    codexProviderShadowed: reservedCodexProviders.has(name) && isOwnCodexRelayEntry(entry, siteBaseUrl),
  }
}

function readCodexAuthMode(paths: string[]): 'apikey' | 'chatgpt' | null {
  const parsed = readJson(paths[1])
  const kind = classifyCodexAuthProfile(parsed)
  if (kind === 'apikey' || kind === 'chatgpt') return kind
  if (kind !== 'mixed') return null
  const mode = nestedString(parsed, ['auth_mode']).trim().toLowerCase()
  if (mode === 'apikey' || mode === 'chatgpt') return mode
  // Codex 0.155.1 `resolved_mode()`（login/src/auth/manager.rs）：没写 auth_mode 时
  // 有 OPENAI_API_KEY 就按 Key 用，令牌被忽略。这里跟着它判，否则首页会把一份
  // 实际走 Key 的配置显示成「官方账号」。
  return 'apikey'
}

export function readCodexAuthTokens(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): unknown | null {
  const parsed = readJson(providerConfigPaths('codex', rootsInput)[1])
  return parsed?.tokens ?? null
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value.trim())
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}`
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * Claude Code 的 /model 菜单、Default 指向与备用型号按这份型号清单重写会不会变（见
 * claude-model-picker.ts 的 claudeRelayModelPickerOutdated）。只读，读之前先过路径校验。
 */
export function claudeModelPickerNeedsRefresh(
  availableModels: readonly string[],
  currentModel: string,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  seeded: SeededToolDefaults = {},
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('claude', roots)
  const [settingsPath] = providerConfigPaths('claude', roots)
  assertSafeConfigPath(settingsPath, providerRoot, 'file')
  return claudeRelayModelPickerOutdated(requireJson(settingsPath, '现有 Claude settings.json'), availableModels, currentModel, seeded.claudeFallbackModel === true)
}

/**
 * Claude Code 的 settings.json 里还没写备用型号（fallbackModel）。开机那轮先看它，有了就不必为补这一项去问中转。
 * 只读，读之前先过路径校验。
 */
export function claudeFallbackModelMissing(rootsInput: ProviderConfigRoots = defaultProviderConfigRoots()): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('claude', roots)
  const [settingsPath] = providerConfigPaths('claude', roots)
  assertSafeConfigPath(settingsPath, providerRoot, 'file')
  return requireJson(settingsPath, '现有 Claude settings.json').fallbackModel === undefined
}

/**
 * Codex 那份型号名单按 expected 重写会不会变（见 codex-model-catalog.ts 的
 * codexRelayModelCatalogOutdated）。只读，读之前先过路径校验；不该有名单时只看那一行，
 * 不去碰名单文件。
 */
export function codexModelCatalogNeedsRefresh(
  expected: string | null,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('codex', roots)
  const [configPath] = providerConfigPaths('codex', roots)
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const parsed = requireToml(configPath, '现有 Codex config.toml')
  if (expected === null) return codexRelayModelCatalogOutdated(parsed, null, null)
  const catalogPath = codexModelCatalogPath(roots)
  assertSafeConfigPath(catalogPath, providerRoot, 'file')
  return codexRelayModelCatalogOutdated(parsed, expected, readText(catalogPath))
}

export interface CodexModelCatalogOnDisk {
  /** config.toml 顶层有本软件写的那一行。 */
  managed: boolean
  /** 那一行指向的名单文件内容；不存在、读不了或被换成链接时是 null。 */
  content: string | null
}

/** 本软件写的型号名单现在是什么样：开机、换了命令行版本之后据此判断还能不能留着。 */
export function inspectCodexModelCatalogOnDisk(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): CodexModelCatalogOnDisk {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('codex', roots)
  const [configPath] = providerConfigPaths('codex', roots)
  assertSafeConfigPath(configPath, providerRoot, 'file')
  if (!isManagedCodexModelCatalogSetting(requireToml(configPath, '现有 Codex config.toml').model_catalog_json)) {
    return { managed: false, content: null }
  }
  return { managed: true, content: codexModelCatalogTargetUsable(roots) ? readText(codexModelCatalogPath(roots)) : null }
}

const managedCodexModelCatalogLine = new RegExp(
  `^\\s*model_catalog_json\\s*=\\s*(["'])${codexModelCatalogFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*(?:#.*)?$`,
)

/** 两份 TOML 读出来的值逐项相同（大整数读出来是 BigInt，JSON.stringify 不认，换成文本比）。 */
function sameTomlValue(left: unknown, right: unknown): boolean {
  function replacer(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? `${value}n` : value
  }
  return JSON.stringify(left, replacer) === JSON.stringify(right, replacer)
}

/**
 * 去掉本软件写的那一行，其余一个字不动（注释、顺序、每一行的换行符都留着）；没有那一行
 * 返回 null。按行删不干净（写法少见）时才退回整份重新排版。
 */
function withoutManagedCodexModelCatalogLine(text: string, label: string): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(text)
  } catch (error) {
    throw new Error(`${label} 无法解析，未执行修改${tomlErrorLocation(error)}`)
  }
  if (!isManagedCodexModelCatalogSetting(parsed.model_catalog_json)) return null
  removeCodexRelayModelCatalog(parsed)
  // 每一行连着它自己的换行符切开，删掉那一行再原样拼回。
  const lines = text.split(/(?<=\n)/)
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line))
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable
  const index = lines.slice(0, topLevelEnd).findIndex((line) => managedCodexModelCatalogLine.test(line.replace(/\r?\n$/, '')))
  if (index !== -1) {
    const next = [...lines.slice(0, index), ...lines.slice(index + 1)].join('')
    try {
      // 删掉的必须恰好是那一个键：读回来与「原样去掉它」逐项一致才用按行删的结果
      // （防的是多行字符串里刚好有一行长得一样）。
      if (sameTomlValue(TOML.parse(next), parsed)) return next
    } catch {
      // 按行删坏了结构：下面整份重排。
    }
  }
  return tomlContent(parsed)
}

function codexConfigWithoutManagedCatalog(filePath: string, label: string, providerRoot: string): FilePlan | null {
  assertSafeConfigPath(filePath, providerRoot, 'file')
  const text = requireConfigText(filePath, label)
  const next = text ? withoutManagedCodexModelCatalogLine(text, label) : null
  return next === null ? null : { path: filePath, content: next }
}

/**
 * 只收回本软件写的 model_catalog_json 那一行（正在用的 config.toml 与切回星芒时用的那份），
 * 不看账号、不联网：命令行退回旧版、桌面端太旧时，名单读不进 Codex 就起不来，这一步
 * 不能等账号核对。名单文件留着。什么都没改返回 null。
 */
export function takeBackCodexModelCatalog(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  hooks: NativeConfigWriteHooks = {},
): NativeConfigSaveResult | null {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('codex', roots)
  const paths = codexConfigSnapshotPaths(roots)
  const plans: FilePlan[] = []
  try {
    const relay = codexConfigWithoutManagedCatalog(paths.relay, '已保存的星芒 Codex 配置', providerRoot)
    if (relay) plans.push(relay)
  } catch {
    // 切回星芒用的那份快照读不了、或被换成了链接：留着不碰，不挡住收回 Codex 正在读的这份。
  }
  const active = codexConfigWithoutManagedCatalog(paths.active, '现有 Codex config.toml', providerRoot)
  if (active) plans.push(active)
  if (plans.length === 0) return null
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}

export function inspectProviderConfig(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  // The relay base URL this provider is expected to point at, for the
  // matchesRelay reconciliation below. Defaults to catalog.ts's fixed map
  // (today's only site) so every existing caller keeps reading exactly what
  // it read before relay-sites.ts existed; a caller that knows the user's
  // active site passes its RelaySite.providerBaseUrls (see system-service.ts's
  // inspectNativeProviderConfig).
  siteBaseUrlsInput: Record<ProviderId, string> = providerBaseUrls,
): NativeConfigInspection {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const paths = providerConfigPaths(provider, roots)
  // Validate before parsing any existing file so a junction cannot redirect the read.
  for (const filePath of paths) assertSafeConfigPath(filePath, providerRoot, 'file')
  const dataDirectory = path.dirname(paths[0])
  const files = paths.map((filePath) => ({
    path: filePath,
    exists: (() => {
      try {
        const info = fs.lstatSync(filePath)
        return info.isFile() && info.nlink <= 1 && !info.isSymbolicLink()
      } catch {
        return false
      }
    })(),
  }))
  const modifiedTimes = files
    .filter((file) => file.exists)
    .map((file) => fs.lstatSync(file.path).mtimeMs)

  const apiKey = readProviderApiKey(provider, paths)
  const model = readProviderModel(provider, paths)
  const authType = readProviderAuthType(provider, paths)
  const actualBaseUrl = readProviderBaseUrl(provider, paths)
  const officialAccount = readOfficialAccountIdentity(provider, paths)
  const baseUrl = siteBaseUrlsInput[provider]
  // 以前的版本只换 base_url 接管过带别家凭据的表（#1083）：地址是星芒的，请求带的却是别家的 Key。
  // 这不是星芒写的中转配置（和 codexProviderShadowed 那种整张都是星芒的表不同），当不匹配：首页给
  // 「改用当前账号」，换型号、刷型号菜单、补缺省项这些自动改写也不碰它。
  const foreignCredentials = provider === 'codex' && readCodexActiveProviderCarriesCredentials(paths[0])
  return {
    baseUrl,
    actualBaseUrl,
    exists: files.some((file) => file.exists),
    hasApiKey: Boolean(apiKey),
    matchesRelay: Boolean(apiKey && actualBaseUrl && relayProviderBaseUrlMatches(provider, actualBaseUrl, baseUrl)) && !foreignCredentials,
    apiKey,
    model,
    ...(authType !== undefined ? { authType } : {}),
    officialAccountEmail: officialAccount.email,
    officialAccountPlan: officialAccount.planLabel,
    officialAccountRenewsAt: officialAccount.renewsAt,
    ...(provider === 'codex' ? {
      codexAuthMode: readCodexAuthMode(paths),
      ...readCodexProviderSelection(paths, baseUrl),
    } : {}),
    ...readConfigFilesBroken(provider, paths),
    ...(provider === 'grok' ? { grokLoginMode: readGrokLogin(path.dirname(paths[0]))?.mode ?? null } : {}),
    dataDirectory,
    dataDirectoryExists: (() => {
      try {
        const info = fs.lstatSync(dataDirectory)
        return info.isDirectory() && !info.isSymbolicLink()
      } catch {
        return false
      }
    })(),
    files,
    updatedAt: modifiedTimes.length ? new Date(Math.max(...modifiedTimes)).toISOString() : null,
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlTableKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value)
}

/** Codex config.toml 里星芒中转用的 model_provider 名。从没配过 Codex 时写这个，不占用官方 OpenAI 表。 */
export const defaultCodexRelayProvider = 'XingmangAI'
const reservedCodexProviders: ReadonlySet<string> = new Set(['openai', 'ollama', 'lmstudio'])

/**
 * The provider's `name` is what Codex Desktop shows in its lower-left picker.
 * Codex treats exactly "OpenAI" (case-sensitive, base_url ignored) as the
 * first-party provider: compaction goes through the remote /responses/compact
 * task and the CLI's /model popup warns that the base URL is overridden.
 * Only the display name changes; the table key stays defaultCodexRelayProvider
 * because the resume picker filters earlier chats by that key.
 *
 * 2026-10-13 yoyo 选的大写 OpenAI，选之前在星芒中转上实测过命令行和桌面端的长对话压缩，
 * 星芒账号和历史账号都通。
 */
export const codexRelayDisplayName = 'OpenAI'
// 8-26（#104）到这次之前的模板写的显示名，和表名一样。
const legacyCodexRelayDisplayName = 'XingmangAI'

/**
 * A custom provider takes the Responses WebSocket transport only when its
 * table says supports_websockets = true; without the key it is false
 * (model-provider-info `#[serde(default)]`, core/src/client.rs
 * responses_websocket_enabled, rust-v0.162.1). The display name does not enter
 * that check. Over WebSocket each later request in a turn sends only the new
 * input against previous_response_id instead of the whole conversation.
 *
 * 2026-10-16 yoyo 定默认开（#992 当时写的是 false）。服务端同日实测：xm 两条线路的 GPT 分组和
 * api.solov.cc 都开了，后续每轮上传约 118 KB 降到约 400 字节，5 步任务 21.8 秒对普通请求 47 秒。
 * 服务端只给 GPT 渠道开了，而这一项对整条线路生效：星芒签的 Key（星芒账号进 GPT 分组、历史账号
 * 进 Codex_pro）用 GPT 型号时写 true；首页「换用别家模型」选了别家型号时写 false，那些渠道不收
 * WebSocket，开着会连着重试甚至报错。走 Cloudflare 时一轮里约 100 秒一个字都不出，WebSocket 会被
 * 当成闲置掐掉，Codex 连着重连 5 次才退回普通请求（10-13 模拟；服务端 7 天数据约占 0.27%）。服务端
 * 的办法是让 CF 入口对 /v1/responses 的 WebSocket 握手回 426：Codex 收到当场改走普通请求、不重试
 * （client.rs 的 UPGRADE_REQUIRED → FallbackToHttp），洛杉矶照常走 WebSocket。所以两条线路写一样的
 * 值，换线路仍只改 base_url（tool-route-rewrite.ts）。
 */
export function codexModelUsesRelayWebsockets(model: string): boolean {
  // Same split as the renderer's isOpenAiModelId (model-filter.ts), which the
  // 换用别家模型 dialog uses to decide what counts as another vendor's model;
  // electron/ does not import src/, so the pattern is repeated here.
  return model.trim().toLowerCase().split(/[/:]/).some((part) => part === 'openai'
    || /^(?:gpt(?:[-_.]|\d|$)|chatgpt(?:[-_.]|\d|$)|codex(?:[-_.]|\d|$)|o\d+(?:[-_.]|$))/.test(part))
}

/**
 * 没写过就按型号补。写过的值要是正好是星芒按上一个型号会写的那个，就当是星芒写的，跟着这次的型号
 * 改（GPT 换到别家 true → false，换回来 false → true）；对不上的是客户自己定的，不动。
 */
function followCodexRelayWebsockets(entry: Record<string, unknown>, previousModel: unknown, model: string): void {
  const next = codexModelUsesRelayWebsockets(model)
  if (entry.supports_websockets === undefined) {
    entry.supports_websockets = next
  } else if (typeof previousModel === 'string' && entry.supports_websockets === codexModelUsesRelayWebsockets(previousModel)) {
    entry.supports_websockets = next
  }
}

/** 只换星芒自己那张表上一字不差的老显示名；客户自己改过的名字、别人写的表都不动。 */
function renameLegacyCodexRelayDisplayName(entry: Record<string, unknown>, siteBaseUrl: string): void {
  if (entry.name === legacyCodexRelayDisplayName && isOwnCodexRelayEntry(entry, siteBaseUrl)) {
    entry.name = codexRelayDisplayName
  }
}

/**
 * Codex resumes a thread with the model_provider recorded when the thread
 * started, not the one selected now (app-server merge_persisted_resume_metadata,
 * rust-v0.162.1), and refuses to open it when config.toml no longer defines that
 * ID: "Model provider `OpenAI` not found". Switching to the official account used
 * to delete our table, so every chat started on the relay stopped opening.
 *
 * The ID now stays defined as an alias of the official route. Without base_url
 * Codex picks the endpoint that fits auth.json (chatgpt.com/backend-api/codex for
 * a ChatGPT login, api.openai.com/v1 for an API key), requires_openai_auth sends
 * that login, and "OpenAI" is the exact display name ModelProviderInfo::is_openai()
 * checks, so the alias behaves like the built-in provider. Those chats open and
 * carry on under the official account. Switching back to the relay restores the
 * table from the relay snapshot, or turns the alias back into the relay route
 * (codexRelayProviderFor, applyCodexRelayConfig), so they move back with it.
 *
 * 2026-10-15 一位客户在 Codex 桌面端上自己改出了一模一样的表，卡住的旧对话接着回了；
 * 写死 api.openai.com 的 base_url 对 ChatGPT 登录不行（Missing scopes: api.responses.write）。
 */
function officialCodexAliasEntry(): Record<string, unknown> {
  return { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true }
}

// 这几项任何一项在，请求就不是拿 auth.json 里的官方登录发去官方地址了。
const codexProviderRouteKeys = ['base_url', 'env_key', 'experimental_bearer_token', 'auth', 'gateway_oauth', 'aws']

/** 走官方登录、不另指地址也不另带凭据的表：星芒切官方时写的，或客户照同样办法自己写的。 */
function isOfficialCodexAliasEntry(entry: unknown): entry is Record<string, unknown> {
  return isJsonRecord(entry) && entry.requires_openai_auth === true
    && codexProviderRouteKeys.every((key) => entry[key] === undefined)
}

// 表里另带凭据、另加请求头或查询参数的几项。有任何一项，请求就不只是拿 auth.json 里那把 Key 发出去：
// env_key 读环境变量里的 Key，http_headers 里可能写死了 Authorization。别家中转的教程常这样写。
const codexProviderCredentialKeys = [
  'env_key', 'env_key_instructions', 'experimental_bearer_token', 'auth', 'gateway_oauth', 'aws',
  'http_headers', 'env_http_headers', 'query_params',
]

/**
 * 这张表另带了自己的凭据或请求参数（#1083）。只换 base_url 接管它，请求还带着别家的 Key 打到星芒，
 * 一用就 401，变量不在时 Codex 干脆起不来；把那几项删掉又是动客户自己写的设置。所以只更新时不接管
 * 这种表，另起一张星芒的，客户那张一个字不动（yoyo 10-18 定的「另起一张」）。代价：以前记在那张表下的
 * Codex 对话不在「继续」列表里，对话文件还在，切回那张表就看得到。
 */
function carriesCodexProviderCredentials(entry: unknown): boolean {
  return isJsonRecord(entry) && codexProviderCredentialKeys.some((key) => entry[key] !== undefined)
}

/** Codex 正在用的那张表（与 readProviderBaseUrl 读地址的是同一张）另带了凭据。 */
function readCodexActiveProviderCarriesCredentials(configPath: string): boolean {
  const parsed = readToml(configPath)
  const providerName = nestedString(parsed, ['model_provider'])
  const providers = parsed?.model_providers
  return Boolean(providerName) && isJsonRecord(providers) && carriesCodexProviderCredentials(providers[providerName])
}

/** 这份配置正在用的星芒中转表名（旧对话记的就是它）；不是中转、或用的是 Codex 内置的名字，返回 null。 */
function activeCodexRelayProviderName(parsed: Record<string, unknown> | null, siteBaseUrl: string): string | null {
  if (!parsed || classifyCodexConfigProfile(parsed, siteBaseUrl) !== 'relay') return null
  const name = String(parsed.model_provider).trim()
  // 内置名下的对话 Codex 自己认得；用这个名字另写一张表，0.162.1 会因「占用内置名」整份配置读不进去。
  return reservedCodexProviders.has(name) ? null : name
}

/**
 * 官方配置里给旧对话记着的那个表名写一张走官方登录的表。同名表已经是这样、或是客户自己的
 * （不指向星芒中转）就原样返回；是星芒中转的活表（以前留下的快照）就换掉，免得旧对话把
 * ChatGPT 登录发给中转。只是加一张新表时接在原文后面，客户自己的注释和排版不动。
 */
function withOfficialCodexAlias(officialText: string, providerName: string | null, siteBaseUrl: string): string {
  if (!providerName) return officialText
  const parsed = parseTomlOrNull(officialText)
  if (!parsed) return officialText
  if (parsed.model_providers !== undefined && !isJsonRecord(parsed.model_providers)) return officialText
  const existing = isJsonRecord(parsed.model_providers) ? parsed.model_providers[providerName] : undefined
  if (existing !== undefined && (isOfficialCodexAliasEntry(existing) || !isOwnCodexRelayEntry(existing, siteBaseUrl))) {
    return officialText
  }
  const alias = officialCodexAliasEntry()
  if (existing === undefined) {
    const appended = [
      withTrailingNewline(officialText),
      `[model_providers.${tomlTableKey(providerName)}]`,
      ...Object.entries(alias).map(([key, value]) => `${key} = ${typeof value === 'string' ? tomlString(value) : String(value)}`),
      '',
    ].join('\n')
    // 原文末尾是行内表 model_providers = { ... } 这类接不上的写法时，退回整份重写。
    if (parseTomlOrNull(appended) !== null) return appended
  }
  ensureRecord(parsed, 'model_providers')[providerName] = alias
  return tomlContent(parsed)
}

/** 星芒替 Codex 存的那份当前账号配置；没有、读不了或读不懂都当没有，切官方不因它失败。 */
function readStoredCodexRelayConfigOrNull(filePath: string): Record<string, unknown> | null {
  try {
    const text = requireConfigText(filePath, '已保存的星芒 Codex 配置')
    return text ? parseTomlOrNull(text) : null
  } catch {
    return null
  }
}

function existingCodexProvider(configPath: string, siteBaseUrl: string): string {
  const content = requireConfigText(configPath, '现有 Codex config.toml')
  if (content === null) return defaultCodexRelayProvider
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(content)
  } catch {
    // Reset is the documented escape hatch for a config the app can no longer
    // read, and first-run onboarding always resets. Refusing to overwrite an
    // unparseable file therefore left exactly the users who needed the escape
    // hatch with no way out of the onboarding screen at all.
    //
    // Only the provider name is being recovered here, so the fallback costs
    // nothing else. Merge is unaffected: it re-reads the same file through
    // requireToml below and still fails loudly, so a broken config is never
    // silently rewritten unless the user explicitly asked for a reset. The
    // overwrite itself is preceded by a timestamped .bak in executeFilePlans.
    return defaultCodexRelayProvider
  }

  return codexRelayProviderFor(parsed, siteBaseUrl)
}

/**
 * Codex merges user tables into its built-in providers with `or_insert`
 * (codex-rs/model-provider-info merge_configured_model_providers), so a table
 * named after a built-in ID is silently ignored and the relay written there
 * never takes effect. The IDs are case-sensitive: `OpenAI` is an ordinary
 * user-definable name, which is why older releases could use it safely.
 *
 * merging：只更新时表里别的键原样留着，带着别家凭据的表不接管（carriesCodexProviderCredentials）。
 * 重置时整份按模板重写，沿用原来的名字也带不过去别家的设置，照旧。
 */
function codexRelayProviderFor(parsed: Record<string, unknown>, siteBaseUrl: string, merging = false): string {
  const active = typeof parsed.model_provider === 'string' ? parsed.model_provider.trim() : ''
  const providers = isJsonRecord(parsed.model_providers) ? parsed.model_providers : {}
  function adoptable(name: string): boolean {
    return !merging || !carriesCodexProviderCredentials(providers[name])
  }
  // Keep a usable active name as is: Codex's resume picker filters sessions by
  // model_provider, so renaming it would hide the customer's earlier chats.
  if (active && !reservedCodexProviders.has(active) && adoptable(active)) return active
  // 切官方时留下的那张走官方登录的表：旧对话记的就是这个名字，切回来接着用它，那些对话才跟着回来。
  const alias = active ? undefined
    : Object.keys(providers).find((key) => !reservedCodexProviders.has(key) && isOfficialCodexAliasEntry(providers[key]) && adoptable(key))
  if (alias) return alias
  function isFree(candidate: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(providers, candidate)) return true
    return (isOwnCodexRelayEntry(providers[candidate], siteBaseUrl) || isOfficialCodexAliasEntry(providers[candidate]))
      && adoptable(candidate)
  }
  // Without a selector, older releases picked `OpenAI`; keep that for the same
  // resume-list reason, but never take over a table someone else wrote.
  if (!active && isFree('OpenAI')) return 'OpenAI'
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? defaultCodexRelayProvider : `${defaultCodexRelayProvider}-${suffix}`
    if (isFree(candidate)) return candidate
  }
}

function isOwnCodexRelayEntry(entry: unknown, siteBaseUrl: string): boolean {
  return isJsonRecord(entry) && typeof entry.base_url === 'string'
    && isKnownCodexRelayBaseUrl(entry.base_url, siteBaseUrl)
}

/**
 * Older releases wrote the relay into the active built-in table. Move only
 * that table of ours to the new name, keeping options such as retries. A
 * built-in-named table someone else wrote stays untouched: Codex ignores it
 * anyway, and refusing to save over it would turn a working switch into an
 * error. A table that also carries its own credentials is not moved either
 * (carriesCodexProviderCredentials): the new table starts clean instead.
 */
function migrateOwnReservedCodexProvider(
  parsed: Record<string, unknown>,
  providerName: string,
  siteBaseUrl: string,
): void {
  const active = typeof parsed.model_provider === 'string' ? parsed.model_provider.trim() : ''
  if (!reservedCodexProviders.has(active) || active === providerName) return
  const providers = parsed.model_providers
  if (!isJsonRecord(providers)) return
  const entry = providers[active]
  if (!isJsonRecord(entry) || !isOwnCodexRelayEntry(entry, siteBaseUrl) || carriesCodexProviderCredentials(entry)) return
  const existing = providers[providerName]
  providers[providerName] = { ...entry, ...(isJsonRecord(existing) ? existing : {}) }
  delete providers[active]
}

function tomlContent(value: Record<string, unknown>): string {
  return TOML.stringify(value as Parameters<typeof TOML.stringify>[0])
}

function codexWorkspaceProjectEntry(
  parsed: Record<string, unknown>,
  workspace: string,
): { key: string; entry: Record<string, unknown> } | null {
  const projects = parsed.projects
  if (!isJsonRecord(projects)) return null
  const wanted = normalizeWorkspacePathKey(workspace)
  const key = Object.keys(projects).find((candidate) => normalizeWorkspacePathKey(candidate) === wanted)
  if (!key) return null
  const entry = projects[key]
  return isJsonRecord(entry) ? { key, entry } : null
}

function codexPermissionControl(
  trustLevel: CodexWorkspaceTrustLevel,
  approvalPolicy: string | null,
): CodexWorkspacePermissionControl {
  const policy = approvalPolicy?.trim().toLowerCase() ?? ''
  if (policy === 'never') return 'restricted'
  if (policy === 'unless-trusted' && trustLevel !== 'trusted') return 'restricted'
  if (trustLevel === 'untrusted' && !policy) return 'restricted'
  // Codex defaults to an unless-trusted policy when no explicit policy exists;
  // an absent project entry therefore behaves as restricted as well.
  if (trustLevel === 'unknown' && !policy) return 'restricted'
  return 'available'
}

export function inspectCodexWorkspacePermissionsText(
  content: string | null,
  workspace: string,
  configPath = 'config.toml',
): CodexWorkspacePermissionStatus {
  const base = {
    configPath,
    workspace,
    configExists: Boolean(content),
    trustLevel: 'unknown' as CodexWorkspaceTrustLevel,
    approvalPolicy: null as string | null,
    permissionProfile: null as string | null,
    sandboxMode: null as string | null,
    control: 'unknown' as CodexWorkspacePermissionControl,
    error: null as string | null,
  }
  if (!content?.trim()) return base

  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(content)
  } catch {
    return { ...base, error: 'Codex config.toml 无法解析' }
  }
  const project = codexWorkspaceProjectEntry(parsed, workspace)
  const rawTrust = project?.entry.trust_level
  const trustLevel = rawTrust === 'trusted' || rawTrust === 'untrusted' ? rawTrust : 'unknown'
  const approvalPolicy = typeof parsed.approval_policy === 'string'
    ? parsed.approval_policy.trim() || null
    : null
  const permissionProfile = typeof parsed.permission_profile === 'string'
    ? parsed.permission_profile.trim() || null
    : typeof parsed.default_permissions === 'string'
      ? parsed.default_permissions.trim() || null
      : null
  const sandboxMode = typeof parsed.sandbox_mode === 'string'
    ? parsed.sandbox_mode.trim() || null
    : null
  return {
    ...base,
    trustLevel,
    approvalPolicy,
    permissionProfile,
    sandboxMode,
    control: codexPermissionControl(trustLevel, approvalPolicy),
  }
}

export function trustCodexWorkspaceInConfigText(
  content: string | null,
  workspace: string,
): { content: string; changed: boolean } {
  const trimmedWorkspace = workspace.trim()
  if (!trimmedWorkspace) throw new Error('Codex 工作目录不能为空')
  let parsed: Record<string, unknown> = {}
  if (content?.trim()) {
    try {
      parsed = TOML.parse(content)
    } catch {
      throw new Error('Codex config.toml 无法解析，未执行修改')
    }
  }
  const projects = ensureRecord(parsed, 'projects')
  const existing = codexWorkspaceProjectEntry(parsed, trimmedWorkspace)
  const key = existing?.key ?? trimmedWorkspace
  const entry = existing?.entry ?? ensureRecord(projects, key)
  let changed = entry.trust_level !== 'trusted'
  entry.trust_level = 'trusted'
  // These are the least-privileged defaults that make the Desktop picker
  // actionable. An explicit user policy (including `never`) is preserved.
  if (parsed.approval_policy === undefined) {
    parsed.approval_policy = 'on-request'
    changed = true
  }
  if (parsed.sandbox_mode === undefined) {
    parsed.sandbox_mode = 'workspace-write'
    changed = true
  }
  return { content: tomlContent(parsed), changed }
}

export function ensureCodexPermissionDefaultsInConfigText(
  content: string,
): { content: string; changed: boolean } {
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(content)
  } catch {
    throw new Error('Codex config.toml 无法解析，未执行修改')
  }
  let changed = false
  if (parsed.approval_policy === undefined) {
    parsed.approval_policy = 'on-request'
    changed = true
  }
  if (parsed.sandbox_mode === undefined) {
    parsed.sandbox_mode = 'workspace-write'
    changed = true
  }
  return { content: changed ? tomlContent(parsed) : withTrailingNewline(content), changed }
}

/**
 * Workspace trust for Claude Code and Gemini CLI, written for the directory the
 * user picked in this app's own folder dialog.
 *
 * Neither field is documented upstream, so the shapes below are what a first
 * run actually wrote on 2026-09-21 (empty HOME + throwaway workspace, driven
 * through a pty, then diffed):
 *
 *   Claude Code 2.1.277 — ~/.claude.json
 *     projects["<绝对路径>"].hasTrustDialogAccepted = true   (信任这个目录)
 *     hasCompletedOnboarding = true                          (主题 / 安全须知向导)
 *   Gemini CLI 0.60.0 — ~/.gemini/trustedFolders.json
 *     { "<绝对路径>": "TRUST_FOLDER" }                        (另两个取值是
 *                                                             TRUST_PARENT 与
 *                                                             DO_NOT_TRUST)
 *
 * Upstream may rename or drop either field at any time, so every write here is
 * read-modify-write on that one file and adds nothing else. A field that
 * disappears must fail silently -- never treat its absence as an error, and
 * never read it back as the source of truth for whether a folder is trusted.
 *
 * 已经写着的条目一律不动：用户自己在 CLI 里选过「不信任」也是一个决定，
 * 本软件不能替他翻案。
 */

export interface WorkspaceTrustWriteResult extends NativeConfigSaveResult {
  changed: boolean
}

function matchingWorkspaceKey(entries: Record<string, unknown>, workspace: string): string | null {
  const wanted = normalizeWorkspacePathKey(workspace)
  const key = Object.keys(entries).find((candidate) => normalizeWorkspacePathKey(candidate) === wanted)
  return key ?? null
}

function requireWorkspaceTrustJson(content: string | null, label: string): Record<string, unknown> {
  if (!content?.trim()) return {}
  try {
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 与 requireJson 同理：解析器的原文会带上出错位置附近的片段，而
    // ~/.claude.json 里有会话历史与 MCP 配置，不能进日志或反馈导出（I13）。
    throw new Error(`${label} 无法解析为 JSON，未执行修改`)
  }
  throw new Error(`${label} 不是有效的 JSON 对象，未执行修改`)
}

export function trustClaudeWorkspaceInRootConfigText(
  content: string | null,
  workspace: string,
): { content: string; changed: boolean } {
  const trimmedWorkspace = workspace.trim()
  if (!trimmedWorkspace) throw new Error('Claude Code 工作目录不能为空')
  const label = '现有 Claude Code ~/.claude.json'
  const parsed = requireWorkspaceTrustJson(content, label)
  // ensureRecord 会把不是对象的值直接换成空对象。对一份只补一个布尔值的
  // 写入来说，那是在拿用户的项目记录换取一次跳过弹窗，宁可整份不动。
  if (parsed.projects !== undefined && !isJsonRecord(parsed.projects)) {
    throw new Error(`${label} 的项目记录已损坏，未执行修改`)
  }
  const projects = ensureRecord(parsed, 'projects')
  const key = matchingWorkspaceKey(projects, trimmedWorkspace) ?? trimmedWorkspace
  if (projects[key] !== undefined && !isJsonRecord(projects[key])) {
    throw new Error(`${label} 的项目记录已损坏，未执行修改`)
  }
  const entry = ensureRecord(projects, key)
  let changed = false
  if (typeof entry.hasTrustDialogAccepted !== 'boolean') {
    entry.hasTrustDialogAccepted = true
    changed = true
  }
  // 首启向导问的是主题与安全须知，登录方式本软件已经配好。对付费客户来说
  // 它只是打开工具后的一段英文问答，跳过它不改变任何已有选择。
  if (typeof parsed.hasCompletedOnboarding !== 'boolean') {
    parsed.hasCompletedOnboarding = true
    changed = true
  }
  return { content: jsonContent(parsed), changed }
}

export function trustClaudeWorkspace(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  workspace: string,
): WorkspaceTrustWriteResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  // ~/.claude.json 与 ~/.claude/ 是并列的两项，所以这条事务的根是主目录本身。
  const root = roots.userHome
  const configPath = path.join(root, '.claude.json')
  assertSafeConfigPath(configPath, root, 'file')
  const current = requireConfigText(
    configPath,
    '现有 Claude Code ~/.claude.json',
    MAX_CLAUDE_ROOT_CONFIG_BYTES,
  )
  const next = trustClaudeWorkspaceInRootConfigText(current, workspace)
  if (!next.changed) return { backups: [], files: [], changed: false }
  assertNoReparseComponents(path.dirname(root), '用户主目录')
  ensureSafeDataDirectory(root, '用户主目录')
  return {
    ...executeFilePlans([{ path: configPath, content: next.content }], {}, root),
    changed: true,
  }
}

// ---------------------------------------------------------------------------
// 星芒画图工具（MCP）
//
// 登录同步后替还在管的几家工具登记同一个 xingmang-image（Gemini CLI 下线后不再登记，
// 已经登记过的由 removeRetiredGeminiIntegrations 收回）。Codex 与 Grok 直接写 config.toml，
// 不走 `codex mcp add`：只装了 Codex 桌面端的客户没有命令行版，照样要能用上。
// 每家只在它的配置目录已经存在时才写，没装过的工具不会被凭空建出目录。

export interface XingmangImageMcpSyncOptions {
  /** Codex 用官方 ChatGPT 登录时它自带画图，不再重复登记。 */
  codex: boolean
}

export interface XingmangImageMcpSyncResult {
  changed: ProviderId[]
  warnings: string[]
}

function existingDirectory(directory: string): boolean {
  try {
    const info = fs.lstatSync(directory)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function parseTomlForMcp(content: string, label: string): Record<string, unknown> {
  try {
    return TOML.parse(content)
  } catch (error) {
    throw new Error(`${label} 无法解析${tomlErrorLocation(error)}，未执行修改`)
  }
}

function syncXingmangImageMcpToml(
  provider: 'codex' | 'grok',
  configPath: string,
  providerRoot: string,
  invocation: XingmangImageMcpInvocation,
  mode: 'register' | 'repoint' = 'register',
): boolean {
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const label = provider === 'codex' ? '现有 Codex config.toml' : '现有 Grok config.toml'
  const current = requireConfigText(configPath, label)
  if (current === null) return false
  const parsed = parseTomlForMcp(current, label)
  const changed = mode === 'register'
    ? applyXingmangImageMcpToToml(parsed, invocation, provider)
    : repointXingmangImageMcpInToml(parsed, invocation)
  if (!changed) return false
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  executeFilePlans([{ path: configPath, content: tomlContent(parsed) }], {}, providerRoot)
  return true
}

function syncXingmangImageMcpClaude(roots: ProviderConfigRoots, invocation: XingmangImageMcpInvocation): boolean {
  const root = roots.userHome
  const claudeRoot = providerConfigRoot('claude', roots)
  const rootConfigPath = path.join(root, '.claude.json')
  const settingsPath = path.join(claudeRoot, 'settings.json')
  assertSafeConfigPath(rootConfigPath, root, 'file')
  assertSafeConfigPath(settingsPath, root, 'file')
  const rootLabel = '现有 Claude Code ~/.claude.json'
  const rootCurrent = requireConfigText(rootConfigPath, rootLabel, MAX_CLAUDE_ROOT_CONFIG_BYTES)
  const rootParsed = requireWorkspaceTrustJson(rootCurrent, rootLabel)
  const plans: FilePlan[] = []
  if (applyXingmangImageMcpToJson(rootParsed, invocation, 'claude')) {
    plans.push({ path: rootConfigPath, content: jsonContent(rootParsed) })
  }
  const settingsLabel = '现有 Claude Code settings.json'
  const settingsCurrent = requireConfigText(settingsPath, settingsLabel)
  if (settingsCurrent !== null) {
    const settingsParsed = requireWorkspaceTrustJson(settingsCurrent, settingsLabel)
    if (applyXingmangImagePermissionToClaudeSettings(settingsParsed)) {
      plans.push({ path: settingsPath, content: jsonContent(settingsParsed) })
    }
  }
  if (plans.length === 0) return false
  assertNoReparseComponents(path.dirname(root), '用户主目录')
  // 两份文件一起提交：只登记了服务器、没放行调用，客户每次都会被问一遍。
  executeFilePlans(plans, {}, root)
  return true
}

/**
 * 存着的两份 Codex 配置切换时整份换回来，里面登记过的那条也换到现在的位置（技能文件夹改了名、
 * Node 换了地方），不补新的。尽力而为：这几份读不懂或写不进去，不该让首页说画图工具没装进 Codex，
 * 下次同步再试。
 */
function repointXingmangImageMcpInCodexFiles(
  configPaths: string[],
  codexHome: string,
  invocation: XingmangImageMcpInvocation,
): void {
  for (const configPath of configPaths) {
    try {
      syncXingmangImageMcpToml('codex', configPath, codexHome, invocation, 'repoint')
    } catch {
      // See above: only registering in the active Xingmang config.toml is reported.
    }
  }
}

/** 每家单独提交、单独失败：一家的配置读不懂，不该拖累另外几家。 */
export function syncXingmangImageMcpConfigs(
  rootsInput: ProviderConfigRoots,
  invocation: XingmangImageMcpInvocation,
  options: XingmangImageMcpSyncOptions,
): XingmangImageMcpSyncResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const changed: ProviderId[] = []
  const warnings: string[] = []
  const steps: Array<[ProviderId, () => boolean]> = [
    ['codex', () => {
      if (!existingDirectory(roots.codexHome)) return false
      const snapshots = codexConfigSnapshotPaths(roots)
      if (!options.codex) {
        // ChatGPT 账号不登记，可从星芒配置整份带过来的那条还在用：只换位置。
        repointXingmangImageMcpInCodexFiles([snapshots.active, snapshots.relay, snapshots.chatgpt], roots.codexHome, invocation)
        return false
      }
      repointXingmangImageMcpInCodexFiles([snapshots.relay, snapshots.chatgpt], roots.codexHome, invocation)
      return syncXingmangImageMcpToml('codex', snapshots.active, roots.codexHome, invocation)
    }],
    ['claude', () => existingDirectory(providerConfigRoot('claude', roots))
      && syncXingmangImageMcpClaude(roots, invocation)],
    ['grok', () => {
      const providerRoot = providerConfigRoot('grok', roots)
      return existingDirectory(providerRoot)
        && syncXingmangImageMcpToml('grok', path.join(providerRoot, 'config.toml'), providerRoot, invocation)
    }],
  ]
  for (const [provider, step] of steps) {
    try {
      if (step()) changed.push(provider)
    } catch (error) {
      warnings.push(`${provider}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { changed, warnings }
}

/**
 * 本软件「打开」某个目录时替用户写下的信任。Codex 的信任连带 approval_policy
 * 与 sandbox_mode 两项默认值，是配置对话框里一个单独的按钮（trustCodexWorkspace），
 * 不在这条路径上；Grok 没有目录信任这一说。
 */
export function trustManagedWorkspace(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  workspace: string,
): WorkspaceTrustWriteResult {
  switch (provider) {
    case 'claude':
      return trustClaudeWorkspace(rootsInput, workspace)
    case 'gemini':
      return trustGeminiWorkspace(rootsInput, workspace)
    case 'codex':
    case 'grok':
      return { backups: [], files: [], changed: false }
  }
}

/**
 * 检查页「个人文件夹里早先留下的设置」（已知36）看哪几个工具记着「信任整个个人文件夹」。
 * #321 以前客户选个人文件夹打开工具时，本软件替他写过 Claude Code 与 Gemini CLI 的信任；
 * Codex 的来自配置窗口那颗按钮，或者 Codex 自己问过之后写下的。只读不改：信任是客户的
 * 设置，这里只说一声。哪一家读不了、读不懂就当它没记着，那份配置坏没坏由那个工具自己
 * 那一项去说，这一项不为它另报一条错。
 */
export type HomeFolderTrustProvider = Extract<ProviderId, 'claude' | 'codex' | 'gemini'>

export function claudeRootConfigTrustsFolder(content: string | null, folder: string): boolean {
  if (!content?.trim()) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    return false
  }
  if (!isJsonRecord(parsed) || !isJsonRecord(parsed.projects)) return false
  const wanted = trustedFolderKey(folder)
  return Object.entries(parsed.projects).some(([key, entry]) =>
    trustedFolderKey(key) === wanted && isJsonRecord(entry) && entry.hasTrustDialogAccepted === true)
}

export function codexConfigTrustsFolder(content: string | null, folder: string): boolean {
  if (!content?.trim()) return false
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(content)
  } catch {
    return false
  }
  if (!isJsonRecord(parsed.projects)) return false
  const wanted = trustedFolderKey(folder)
  return Object.entries(parsed.projects).some(([key, entry]) =>
    trustedFolderKey(key) === wanted && isJsonRecord(entry) && entry.trust_level === 'trusted')
}

function readTrustConfigText(filePath: string, root: string, label: string, maximumBytes?: number): string | null {
  if (!fs.existsSync(filePath)) return null
  assertSafeConfigPath(filePath, root, 'file')
  return requireConfigText(filePath, label, maximumBytes)
}

export function inspectHomeFolderTrust(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): HomeFolderTrustProvider[] {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const home = roots.userHome
  const codexConfig = codexConfigSnapshotPaths(roots).active
  const geminiRoot = providerConfigRoot('gemini', roots)
  const checks: ReadonlyArray<readonly [HomeFolderTrustProvider, () => boolean]> = [
    ['claude', () => claudeRootConfigTrustsFolder(
      readTrustConfigText(path.join(home, '.claude.json'), home, '现有 Claude Code ~/.claude.json', MAX_CLAUDE_ROOT_CONFIG_BYTES),
      home,
    )],
    ['codex', () => codexConfigTrustsFolder(
      readTrustConfigText(codexConfig, path.dirname(codexConfig), '现有 Codex config.toml'),
      home,
    )],
    ['gemini', () => geminiTrustedFoldersTrustFolder(
      readTrustConfigText(path.join(geminiRoot, 'trustedFolders.json'), geminiRoot, '现有 Gemini CLI trustedFolders.json'),
      home,
    )],
  ]
  return checks.filter(([, trusts]) => {
    try {
      return trusts()
    } catch {
      return false
    }
  }).map(([provider]) => provider)
}

function updateEnvContent(content: string, updates: Record<string, string>): string {
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  for (const [name, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => line.trimStart().startsWith(`${name}=`))
    const replacement = `${name}=${value}`
    if (index >= 0) lines[index] = replacement
    else lines.push(replacement)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 删除若干环境变量行,其余行(含用户自己写的变量与注释)原样保留 ——
 * 切回官方订阅时只收回我们写进去的那几个,绝不重排或清空别人的 .env。
 */
function removeEnvEntries(content: string, names: readonly string[]): string {
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const kept = lines.filter((line) => !names.some((name) => line.trimStart().startsWith(`${name}=`)))
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

function createPlans(
  provider: ProviderId,
  apiKey: string,
  model: string,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
  claudeStatusLineCommand?: string,
  availableModels?: readonly string[],
  cliHook?: CliHookInvocation,
  codexModelCatalog?: string | null,
  seeded: SeededToolDefaults = {},
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  switch (provider) {
    case 'codex':
      return [
        ...createCodexRelayConfigPlans(model, roots, siteBaseUrls, 'reset', cliHook, codexModelCatalog),
        ...createCodexRelayAuthPlans(apiKey, roots, 'reset'),
      ]
    case 'claude': {
      const env: Record<string, unknown> = {
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_BASE_URL: siteBaseUrls.claude,
        DISABLE_AUTOUPDATER: '1',
      }
      const settings: Record<string, unknown> = {
        env,
        permissions: { defaultMode: 'bypassPermissions', deny: [...claudeDeniedRelayTools] },
        model,
        effortLevel: 'medium',
        skipDangerousModePermissionPrompt: true,
        skipWebFetchPreflight: true,
        language: MANAGED_CLAUDE_RESPONSE_LANGUAGE,
        cleanupPeriodDays: MANAGED_CLAUDE_RETENTION_DAYS,
        ...(claudeStatusLineCommand ? { statusLine: claudeStatusLineSetting(claudeStatusLineCommand) } : {}),
      }
      if (availableModels) applyClaudeRelayModelPicker(settings, env, availableModels, model, seeded.claudeFallbackModel === true)
      if (cliHook) applyClaudeCliHooks(settings, cliHook)
      // 原文件读不出来时照旧重建（reset 本来就是给配置坏了的人用的），只是没东西可挪。
      const aside = claudeForeignSettingsAsidePlans(settings, readJson(paths[0]) ?? {}, roots, apiKey)
      return [...aside, { path: paths[0], content: jsonContent(settings) }]
    }
    case 'gemini': {
      const settings: Record<string, unknown> = {
        general: {
          enableAutoUpdate: false,
          enableAutoUpdateNotification: false,
          sessionRetention: { maxAge: MANAGED_GEMINI_SESSION_MAX_AGE },
        },
        ide: { enabled: true },
        privacy: { usageStatisticsEnabled: false },
        security: { auth: { selectedType: 'gemini-api-key' } },
        modelConfigs: { customOverrides: buildGeminiRelayModelOverrides(geminiCliCompatibleModel(model)) },
      }
      if (cliHook) applyGeminiCliHooks(settings, cliHook)
      return [
        ...geminiUsageStatisticsRecordPlans(roots),
        {
          path: paths[0],
          content: jsonContent(settings),
        },
        {
          path: paths[1],
          content: [
            `GOOGLE_GEMINI_BASE_URL=${siteBaseUrls.gemini}`,
            `GEMINI_API_KEY=${apiKey}`,
            `GEMINI_MODEL=${geminiCliCompatibleModel(model)}`,
            '',
          ].join('\n'),
        },
      ]
    }
    case 'grok':
      return [{
        path: paths[0],
        content: [
          '[cli]',
          'auto_update = false',
          '',
          '[models]',
          'default = "grok"',
          'web_search = "grok"',
          'session_summary = "grok"',
          'image_description = "grok"',
          'allowed_models = ["grok"]',
          '',
          '[model."grok"]',
          `model = ${tomlString(model)}`,
          `base_url = ${tomlString(siteBaseUrls.grok)}`,
          `name = ${tomlString(model)}`,
          `api_key = ${tomlString(apiKey)}`,
          'api_backend = "responses"',
          'context_window = 1000000',
          'supports_backend_search = true',
          '',
          '[endpoints]',
          `xai_api_base_url = ${tomlString(siteBaseUrls.grok)}`,
          '',
        ].join('\n') + grokCliHookTemplate(cliHook),
      }]
  }
}

// 初始模板里没有 compat / hooks 两张表，接在末尾不会撞上。
function grokCliHookTemplate(cliHook: CliHookInvocation | undefined): string {
  if (!cliHook) return ''
  const extra: Record<string, unknown> = {}
  applyGrokCliHooks(extra, cliHook)
  return `\n${tomlContent(extra)}`
}

function createMergePlans(
  provider: ProviderId,
  apiKey: string,
  model: string,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
  claudeStatusLineCommand?: string,
  availableModels?: readonly string[],
  cliHook?: CliHookInvocation,
  codexModelCatalog?: string | null,
  seeded: SeededToolDefaults = {},
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  const initialPlans = new Map(
    createPlans(provider, apiKey, model, roots, siteBaseUrls, claudeStatusLineCommand, availableModels, cliHook, undefined, seeded)
      .map((plan) => [plan.path, plan]),
  )
  const initial = (filePath: string): FilePlan => {
    const plan = initialPlans.get(filePath)
    if (!plan) throw new Error(`缺少初始配置模板：${filePath}`)
    return plan
  }

  switch (provider) {
    case 'codex':
      return [
        ...createCodexRelayConfigPlans(model, roots, siteBaseUrls, 'merge', cliHook, codexModelCatalog),
        ...createCodexRelayAuthPlans(apiKey, roots, 'merge'),
      ]
    case 'claude': {
      if (!fs.existsSync(paths[0])) return [initial(paths[0])]
      const parsed = requireJson(paths[0], '现有 Claude settings.json', 'Claude Code')
      const env = ensureRecord(parsed, 'env')
      env.ANTHROPIC_AUTH_TOKEN = apiKey
      env.ANTHROPIC_BASE_URL = siteBaseUrls.claude
      disableClaudeSelfUpdate(env)
      const permissions = ensureRecord(parsed, 'permissions')
      denyClaudeRelayTool(permissions)
      skipClaudeCommandConfirmation(parsed, permissions)
      skipClaudeWebFetchPreflight(parsed)
      ensureClaudeResponseLanguage(parsed)
      extendClaudeSessionRetention(parsed)
      if (claudeStatusLineCommand) applyClaudeStatusLine(parsed, claudeStatusLineCommand)
      if (cliHook) applyClaudeCliHooks(parsed, cliHook)
      if (availableModels) applyClaudeRelayModelPicker(parsed, env, availableModels, model, seeded.claudeFallbackModel === true)
      parsed.model = model
      const aside = claudeForeignSettingsAsidePlans(parsed, null, roots, apiKey)
      return [...aside, { path: paths[0], content: jsonContent(parsed) }]
    }
    case 'gemini': {
      const plans: FilePlan[] = []
      if (!fs.existsSync(paths[0])) {
        plans.push(...geminiUsageStatisticsRecordPlans(roots), initial(paths[0]))
      } else {
        const { parsed, original } = requireGeminiJson(paths[0], '现有 Gemini settings.json', 'Gemini CLI')
        // Gemini CLI keeps the auth strategy in settings.json. Updating only
        // .env after a prior OAuth login leaves the UI looking configured while
        // the CLI continues to authenticate with Google, so merge must restore
        // the API-key selector just like reset does.
        ensureRecord(ensureRecord(parsed, 'security'), 'auth').selectedType = 'gemini-api-key'
        disableGeminiSelfUpdate(parsed)
        extendGeminiSessionRetention(parsed)
        applyGeminiRelayModelOverrides(parsed, geminiCliCompatibleModel(model))
        const statisticsUnset = geminiUsageStatisticsSetting(parsed) === undefined
        disableGeminiRelayUsageStatistics(parsed)
        if (cliHook) applyGeminiCliHooks(parsed, cliHook)
        if (statisticsUnset) plans.push(...geminiUsageStatisticsRecordPlans(roots))
        plans.push({ path: paths[0], content: geminiJsonContent(original, parsed) })
      }
      // 读取失败必须中止保存，静默当空文件会把用户已有环境变量覆盖掉。
      const content = requireConfigText(paths[1], '现有 Gemini .env')
      if (content === null) {
        plans.push(initial(paths[1]))
      } else {
        plans.push({
          path: paths[1],
          content: updateEnvContent(content, {
            GOOGLE_GEMINI_BASE_URL: siteBaseUrls.gemini,
            GEMINI_API_KEY: apiKey,
            GEMINI_MODEL: geminiCliCompatibleModel(model),
          }),
        })
      }
      return plans
    }
    case 'grok': {
      if (!fs.existsSync(paths[0])) return [initial(paths[0])]
      const parsed = requireToml(paths[0], '现有 Grok config.toml', 'Grok CLI')
      // 切回官方时整张中转模型表连同 models.default 一起拿掉（createOfficialAccountPlans）。
      // 再切回当前账号时按初始模板补回，不让用户去点「重置为初始状态」。
      if (!nestedString(parsed, ['models', 'default'])) addManagedGrokModel(parsed)
      const defaultModel = nestedString(parsed, ['models', 'default'])
      const models = ensureRecord(parsed, 'model')
      const target = models[defaultModel]
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new Error(describeConfigReset('Grok CLI', 'Grok CLI 的配置文件里默认模型那一段不对'))
      }
      const targetModel = target as Record<string, unknown>
      targetModel.api_key = apiKey
      targetModel.model = model
      targetModel.base_url = siteBaseUrls.grok
      disableGrokSelfUpdate(parsed)
      pointGrokXaiApiAtRelay(parsed, siteBaseUrls.grok)
      pinGrokModelsToRelay(parsed, defaultModel)
      if (cliHook) applyGrokCliHooks(parsed, cliHook)
      return [{ path: paths[0], content: tomlContent(parsed) }]
    }
  }
}

export function saveProviderConfig(
  provider: ProviderId,
  apiKeyInput: string,
  modelInput: string,
  mode: NativeConfigSaveMode,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  hooks: NativeConfigWriteHooks = {},
  // The relay base URL(s) written into the freshly-created/merged config.
  // No default (unlike inspectProviderConfig's read-side counterpart above):
  // this is what actually lands in the user's CLI config file, so a caller
  // that forgets to pass the active site's RelaySite.providerBaseUrls must
  // fail to compile rather than silently writing the default site's URLs.
  // Every real call site knows its active site (system-service.ts resolves
  // it from AppSettings.relaySiteId); pass catalog.ts's providerBaseUrls
  // explicitly only where "today's only site" is genuinely the right answer
  // (tests fixed to a single site).
  siteBaseUrlsInput: Record<ProviderId, string>,
  // Claude Code 状态行那条命令（`"<node>" "<随包脚本>"`）。缺省 = 不写状态行，
  // 与从前一致：解析不到托管 Node、脚本没随包拷进来、路径里有 shell 元字符，
  // 调用方都只是不传，配置的其余部分照写。见 claude-status-line.ts。
  claudeStatusLineCommand?: string,
  // 当前 Key 可用的模型清单。Claude Code 用它把 /model 菜单换成账号实际能用的型号
  // （见 claude-model-picker.ts）；缺省 = 不动菜单。
  availableModels?: readonly string[],
  // 终端里出错、做完、等人时通知星芒的钩子（见 cli-hooks.ts）。缺省 = 不写，与从前一致；
  // 只有 Claude Code 与 Gemini CLI 用得上，其余工具传了也不看。
  cliHook?: CliHookInvocation,
  // 写给 Codex 的型号名单全文（codex-model-catalog.ts）：null = 收回本软件写的那一行，
  // 缺省 = 不动，与从前一致。只有 Codex 看。
  codexModelCatalog?: string | null,
  // 这台电脑上出现过、客户删了就不再补的几样（见 SeededToolDefaults）。缺省 = 都没出现过，照旧补。
  seeded: SeededToolDefaults = {},
): NativeConfigSaveResult {
  const apiKey = apiKeyInput.trim()
  const model = modelInput.trim()
  if (!apiKey) throw new Error('API Key 不能为空')
  if (/\r|\n/.test(apiKey)) throw new Error('API Key 不能包含换行符')
  if (!model) throw new Error('使用模型不能为空，请先检测并选择模型')
  if (/\r|\n/.test(model)) throw new Error('模型名称不能包含换行符')

  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const configuredPaths = providerConfigPaths(provider, roots)
  for (const filePath of configuredPaths) assertSafeConfigPath(filePath, providerRoot, 'file')

  const statusLineCommand = claudeStatusLineCommand?.trim() || undefined
  if (statusLineCommand && /\r|\n/.test(statusLineCommand)) throw new Error('状态行命令不能包含换行符')
  const plans = [
    ...(mode === 'merge'
      ? createMergePlans(provider, apiKey, model, roots, siteBaseUrlsInput, statusLineCommand, availableModels, cliHook, codexModelCatalog, seeded)
      : createPlans(provider, apiKey, model, roots, siteBaseUrlsInput, statusLineCommand, availableModels, cliHook, codexModelCatalog, seeded)),
    ...globalResponseLanguagePlans(provider, roots, seeded),
  ]

  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}

/**
 * 换线路时定点改写的打算。rewrite = 要改，from 是改之前的地址；其余都是一个字不动：
 * on-target 已经在目标线路上；not-on-site 写的不是本站的线路（客户自己填的别的地址）；
 * unlocated 在文件里找不到要改的那一处（Codex 用的是保留名、Grok 默认模型那张表不在、
 * 写法认不出）；missing 配置文件不在。
 */
export type ProviderRoutePlan =
  | { status: 'rewrite'; from: string; file: string; original: string; content: string }
  | { status: 'on-target' | 'not-on-site' | 'unlocated' | 'missing' }

export type ProviderRouteRewrite = Extract<ProviderRoutePlan, { status: 'rewrite' }>

interface ProviderRouteLocation {
  file: string
  current: string | null
  edits: StringValueEdit[]
  rewrite(content: string, edits: readonly StringValueEdit[]): string | null
}

function locateProviderRoute(provider: ProviderId, paths: string[], text: string, target: string, siteId: string): ProviderRouteLocation | 'unlocated' {
  switch (provider) {
    case 'codex': {
      // 按 model_provider 找表，不写死 XingmangAI：老版本写过 OpenAI，客户也可能起了自己的名字。
      // 保留名那张表 Codex 根本不读，改了也白改，交给开机修复（permitsShadowedCodexRepair）那条路。
      const name = readTomlString(text, ['model_provider'])
      if (!name || reservedCodexProviders.has(name.trim())) return 'unlocated'
      const keyPath = ['model_providers', name, 'base_url']
      return { file: paths[0], current: readTomlString(text, keyPath), edits: [{ path: keyPath, value: target }], rewrite: rewriteTomlStrings }
    }
    case 'claude': {
      const keyPath = ['env', 'ANTHROPIC_BASE_URL']
      return { file: paths[0], current: readJsonString(text, keyPath), edits: [{ path: keyPath, value: target }], rewrite: rewriteJsonStrings }
    }
    case 'gemini':
      return {
        file: paths[1],
        current: readEnvLineValue(text, 'GOOGLE_GEMINI_BASE_URL'),
        edits: [{ path: ['GOOGLE_GEMINI_BASE_URL'], value: target }],
        rewrite: (content, edits) => rewriteEnvValue(content, edits[0].path[0], edits[0].value),
      }
    case 'grok': {
      // 默认模型那张表按 [models].default 找（同 createMergePlans），"grok" 只是新模板里的名字。
      const name = readTomlString(text, ['models', 'default'])
      if (!name) return 'unlocated'
      const keyPath = ['model', name, 'base_url']
      const edits: StringValueEdit[] = [{ path: keyPath, value: target }]
      // 出图那条地址只在它本来就指着本站某条线路时跟着换，客户指去别处的不碰。
      const xai = readTomlString(text, ['endpoints', 'xai_api_base_url'])
      if (xai !== null && !relayProviderBaseUrlEquals(xai, target) && relaySiteEndpointIdForBaseUrl(siteId, provider, xai) !== null) {
        edits.push({ path: ['endpoints', 'xai_api_base_url'], value: target })
      }
      return { file: paths[0], current: readTomlString(text, keyPath), edits, rewrite: rewriteTomlStrings }
    }
  }
}

/**
 * 换线路时只把工具配置里的地址换到 target（工具线路上这个工具的地址），文件其余字节原样
 * （xm 三线路 C9）。不查模型、不碰 Key、不整份合并。要改的地址必须本来就是本站某条线路（含
 * 退役别名），别的地址不碰。这里只算出要写成什么，写由 applyProviderRouteFollow 做。
 */
export function planProviderRouteFollow(
  provider: ProviderId,
  siteId: string,
  target: string,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): ProviderRoutePlan {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const paths = providerConfigPaths(provider, roots)
  for (const filePath of paths) assertSafeConfigPath(filePath, providerRoot, 'file')
  const file = provider === 'gemini' ? paths[1] : paths[0]
  const original = requireRawConfigText(file, '工具配置')
  if (original === null) return { status: 'missing' }
  const location = locateProviderRoute(provider, paths, withoutByteOrderMark(original), target, siteId)
  if (location === 'unlocated' || location.current === null) return { status: 'unlocated' }
  const from = location.current
  const baseOnTarget = relayProviderBaseUrlEquals(from, target)
  if (baseOnTarget && location.edits.length === 1) return { status: 'on-target' }
  if (!baseOnTarget && relaySiteEndpointIdForBaseUrl(siteId, provider, from) === null) return { status: 'not-on-site' }
  const content = location.rewrite(original, baseOnTarget ? location.edits.slice(1) : location.edits)
  if (content === null) return { status: 'unlocated' }
  return { status: 'rewrite', from, file: location.file, original, content }
}

/**
 * 照 planProviderRouteFollow 算好的写下去。照旧走两阶段提交（I9），这次的 .bak 写成就删，不挤占
 * 客户自己保存时留下的备份；替换前再读一遍原文，被别的程序改过就整个放弃，留给下一次重试。
 */
export function applyProviderRouteFollow(
  provider: ProviderId,
  plan: ProviderRouteRewrite,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): void {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  if (!providerConfigPaths(provider, roots).includes(plan.file)) throw new Error('工具配置路径不对，已拒绝写入')
  assertSafeConfigPath(plan.file, providerRoot, 'file')
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  executeFilePlans([{ path: plan.file, content: plan.content }], {
    beforeReplace: () => {
      if (requireRawConfigText(plan.file, '工具配置') !== plan.original) throw new Error('工具配置在改线路时被别的程序改了，这次先不改')
    },
  }, providerRoot, 'discard')
}

/**
 * 开机换掉已下架型号时定点改写的打算（#1154 第 4 条）。rewrite = 要改，original 是改之前的原文，
 * catalog 是 Codex 跟着要重写的型号名单；changed = 配置里的型号已经不是要换的那个（客户刚改过、
 * 别的程序写过）；unlocated = 认不出型号写在哪；missing = 配置文件不在。除了 rewrite 都一个字不动。
 */
export type ProviderModelPlan =
  | { status: 'rewrite'; file: string; original: string; content: string; catalog?: FileWritePlan }
  | { status: 'changed' | 'unlocated' | 'missing' }

export type ProviderModelRewrite = Extract<ProviderModelPlan, { status: 'rewrite' }>

interface ProviderModelLocation {
  current: string | null
  edits: ValueEdit[]
  rewrite(content: string): string | null
}

function sameModelName(value: string | null, model: string): boolean {
  return value !== null && value.trim() === model
}

function locateProviderModel(provider: ProviderId, text: string, from: string, to: string): ProviderModelLocation | 'unlocated' {
  switch (provider) {
    case 'claude': {
      const edits: StringValueEdit[] = [{ path: ['model'], value: to }]
      // /model 菜单里「Default」那一行指着它（claude-model-picker.ts）；客户另指了别的型号就不碰。
      if (sameModelName(readJsonString(text, ['env', 'ANTHROPIC_DEFAULT_MODEL']), from)) edits.push({ path: ['env', 'ANTHROPIC_DEFAULT_MODEL'], value: to })
      return { current: readJsonString(text, ['model']), edits, rewrite: (content) => rewriteJsonStrings(content, edits) }
    }
    case 'codex': {
      const edits: ValueEdit[] = [{ path: ['model'], value: to }]
      // 模板里 review_model 和 model 写的是同一个；不一样就是客户自己定的审查型号，不跟着换。
      if (sameModelName(readTomlString(text, ['review_model']), from)) edits.push({ path: ['review_model'], value: to })
      // WebSocket 开关同 followCodexRelayWebsockets：正好是星芒按旧型号会写的那个值才跟着换，没写的不补。
      const name = readTomlString(text, ['model_provider'])
      const websocketsPath = name ? ['model_providers', name, 'supports_websockets'] : null
      const websockets = websocketsPath ? readTomlBoolean(text, websocketsPath) : null
      if (websocketsPath && websockets === codexModelUsesRelayWebsockets(from) && websockets !== codexModelUsesRelayWebsockets(to)) {
        edits.push({ path: websocketsPath, value: !websockets })
      }
      return { current: readTomlString(text, ['model']), edits, rewrite: (content) => rewriteTomlValues(content, edits) }
    }
    case 'grok': {
      // 默认模型那张表按 [models].default 找，同 readProviderModel；出图地址那些别的值一概不碰。
      const name = readTomlString(text, ['models', 'default'])
      if (!name) return 'unlocated'
      const edits: StringValueEdit[] = [{ path: ['model', name, 'model'], value: to }]
      return { current: readTomlString(text, ['model', name, 'model']), edits, rewrite: (content) => rewriteTomlStrings(content, edits) }
    }
    case 'gemini':
      // 已下线（catalog.ts 的 retiredProviderIds），不替它换型号。
      return 'unlocated'
  }
}

/**
 * 开机换掉已下架的型号时只改型号那几处，文件其余字节原样：整份合并会顺带把 Codex 客户自己定的
 * review_model、Grok 的出图地址、TOML 注释都改掉（#1154 第 4 条）。要换的型号必须还是配置里那个。
 * codexModelCatalog 是按新型号算好的 Codex 型号名单（system-service.ts 的 resolveCodexModelCatalog）：
 * 配置本来就指着本软件的名单文件时一起重写那份文件；该收回那一行、或该补上那一行的这次不动，
 * 下次核对菜单时再说。这里只算出要写成什么，写由 applyProviderModelReplace 做。
 */
export function planProviderModelReplace(
  provider: ProviderId,
  from: string,
  to: string,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  codexModelCatalog?: string | null,
): ProviderModelPlan {
  if (!to.trim() || /\r|\n/.test(to)) throw new Error('模型名称不能为空或包含换行符')
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const paths = providerConfigPaths(provider, roots)
  for (const filePath of paths) assertSafeConfigPath(filePath, providerRoot, 'file')
  const file = paths[0]
  const original = requireRawConfigText(file, '工具配置')
  if (original === null) return { status: 'missing' }
  const text = withoutByteOrderMark(original)
  const location = locateProviderModel(provider, text, from, to.trim())
  if (location === 'unlocated' || location.current === null) return { status: 'unlocated' }
  if (!sameModelName(location.current, from)) return { status: 'changed' }
  const content = location.rewrite(original)
  if (content === null) return { status: 'unlocated' }
  let catalog: FileWritePlan | undefined
  if (provider === 'codex' && typeof codexModelCatalog === 'string' && codexModelCatalogTargetUsable(roots)
    && isManagedCodexModelCatalogSetting(readTomlString(text, ['model_catalog_json']))) {
    const catalogPath = codexModelCatalogPath(roots)
    if (readText(catalogPath) !== codexModelCatalog) catalog = { path: catalogPath, content: codexModelCatalog }
  }
  return { status: 'rewrite', file, original, content, ...(catalog ? { catalog } : {}) }
}

/**
 * 照 planProviderModelReplace 算好的写下去。照旧走两阶段提交（I9），Codex 的型号名单先落盘（同
 * createCodexRelayConfigPlans）；替换配置前再读一遍原文，被别的程序改过就整个放弃，名单一起退回去。
 */
export function applyProviderModelReplace(
  provider: ProviderId,
  plan: ProviderModelRewrite,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): NativeConfigSaveResult {
  return commitProviderRewrite(provider, plan, rootsInput, '工具配置在换型号时被别的程序改了，这次先不换')
}

/**
 * 定点改写落盘（换型号、刷新菜单共用）。配置原文没变（只重写 Codex 的型号名单）就不碰配置文件，
 * 免得每次刷新都多一份备份；名单照旧先落盘。每替换一个文件前都再读一遍配置原文，被别的程序改过
 * 就整个放弃，已经换上的名单一起退回去。
 */
function commitProviderRewrite(
  provider: ProviderId,
  plan: ProviderModelRewrite | ProviderPickerRewrite,
  rootsInput: ProviderConfigRoots,
  raceMessage: string,
): NativeConfigSaveResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  if (providerConfigPaths(provider, roots)[0] !== plan.file) throw new Error('工具配置路径不对，已拒绝写入')
  if (plan.catalog && (provider !== 'codex' || plan.catalog.path !== codexModelCatalogPath(roots))) throw new Error('型号名单路径不对，已拒绝写入')
  assertSafeConfigPath(plan.file, providerRoot, 'file')
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  const plans: FilePlan[] = [
    ...(plan.catalog ? [plan.catalog] : []),
    ...(plan.content === plan.original ? [] : [{ path: plan.file, content: plan.content }]),
  ]
  if (!plans.length) return { backups: [], files: [] }
  return executeFilePlans(plans, {
    beforeReplace: () => {
      if (requireRawConfigText(plan.file, '工具配置') !== plan.original) throw new Error(raceMessage)
    },
  }, providerRoot)
}

/**
 * 打开前、开机核对时刷新型号菜单的打算（#1154 后续）。以前借 saveConfig 的整份合并，模板里每一项都
 * 按当前版本重写一遍：Codex 客户自己定的 review_model、打开的检查更新、注释，Claude Code 放开的
 * deny 项、另指的「Default」都被改回去。现在只动菜单本身，文件其余字节原样：
 * - Claude Code：settings.json 里的 modelPicker、env.ANTHROPIC_DEFAULT_MODEL 和没写过的 fallbackModel，改不改照
 *   claude-model-picker.ts 的 claudeRelayModelPickerUpdates。
 * - Codex：型号名单文件按 codexModelCatalog 重写（system-service.ts 的 resolveCodexModelCatalog 算好的；
 *   undefined = 原样不动）；config.toml 里本软件那一行该有却没有就补上，不该有就收回，客户自己指向
 *   别处的不动。
 * current = 菜单已经是这样了；changed = 配置里的型号已经不是 model（客户刚改过、别的程序写过）；
 * unlocated = 认不出该写在哪；missing = 配置文件不在。除了 rewrite 都一个字不动。写由 applyProviderPickerRefresh 做。
 */
export type ProviderPickerPlan =
  | { status: 'rewrite'; file: string; original: string; content: string; catalog?: FileWritePlan }
  | { status: 'current' | 'changed' | 'unlocated' | 'missing' }

export type ProviderPickerRewrite = Extract<ProviderPickerPlan, { status: 'rewrite' }>

export function planProviderPickerRefresh(
  provider: ProviderId,
  model: string,
  availableModels: readonly string[],
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  codexModelCatalog?: string | null,
  seeded: SeededToolDefaults = {},
): ProviderPickerPlan {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const paths = providerConfigPaths(provider, roots)
  for (const filePath of paths) assertSafeConfigPath(filePath, providerRoot, 'file')
  const file = paths[0]
  const original = requireRawConfigText(file, '工具配置')
  if (original === null) return { status: 'missing' }
  // 字节顺序标记照原样留着（同换线路、换型号的定点改写），解析时去掉。
  const byteOrderMark = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = original.slice(byteOrderMark.length)
  switch (provider) {
    case 'claude': {
      const next = claudeSettingsWithRelayPicker(text, model.trim(), availableModels, seeded.claudeFallbackModel === true)
      if (next === 'changed' || next === 'unlocated') return { status: next }
      return next === text ? { status: 'current' } : { status: 'rewrite', file, original, content: `${byteOrderMark}${next}` }
    }
    case 'codex': {
      const parsed = parseTomlOrNull(text)
      if (!parsed) return { status: 'unlocated' }
      if (!sameModelName(typeof parsed.model === 'string' ? parsed.model : null, model.trim())) return { status: 'changed' }
      const setting = parsed.model_catalog_json
      if (codexModelCatalog === undefined || (setting !== undefined && !isManagedCodexModelCatalogSetting(setting))) return { status: 'current' }
      if (codexModelCatalog === null) {
        if (setting === undefined) return { status: 'current' }
        const next = withoutManagedCodexModelCatalogLine(text, '现有 Codex config.toml')
        return next === null ? { status: 'current' } : { status: 'rewrite', file, original, content: `${byteOrderMark}${next}` }
      }
      // 名单的位置被换成了链接：resolveCodexModelCatalog 那时就该给 null，这里再拦一道。
      if (!codexModelCatalogTargetUsable(roots)) return { status: 'unlocated' }
      const catalogPath = codexModelCatalogPath(roots)
      const catalog = readText(catalogPath) === codexModelCatalog ? undefined : { path: catalogPath, content: codexModelCatalog }
      const next = setting === undefined ? withManagedCodexModelCatalogLine(text) : text
      if (next === null) return { status: 'unlocated' }
      if (!catalog && next === text) return { status: 'current' }
      return { status: 'rewrite', file, original, content: `${byteOrderMark}${next}`, ...(catalog ? { catalog } : {}) }
    }
    case 'gemini':
    case 'grok':
      // 这两家没有本软件管的型号菜单（tool-model-check.ts 的 hasModelPicker）。
      return { status: 'unlocated' }
  }
}

/** 照 planProviderPickerRefresh 算好的写下去，规矩同 applyProviderModelReplace（I9）。 */
export function applyProviderPickerRefresh(
  provider: ProviderId,
  plan: ProviderPickerRewrite,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): NativeConfigSaveResult {
  return commitProviderRewrite(provider, plan, rootsInput, '工具配置在刷新型号菜单时被别的程序改了，这次先不刷新')
}

/**
 * Claude Code 的 settings.json 只改菜单那几处（菜单、Default 指向、没写过的备用型号），其余字节（缩进、
 * 键的顺序、客户自己的设置）原样。
 * Claude Code 按严格 JSON 读这份文件；改完整份再读一遍，和「原来的内容只改了这几处」逐项比对，
 * 对不上（比如同一个键写了两遍）就当认不出，一个字不动。
 */
function claudeSettingsWithRelayPicker(text: string, model: string, availableModels: readonly string[], fallbackSeeded: boolean): string | 'changed' | 'unlocated' {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'unlocated'
  }
  if (!isJsonObject(parsed)) return 'unlocated'
  if (!sameModelName(typeof parsed.model === 'string' ? parsed.model : null, model)) return 'changed'
  if (parsed.env !== undefined && !isJsonObject(parsed.env)) return 'unlocated'
  const updates = claudeRelayModelPickerUpdates(parsed, availableModels, model, fallbackSeeded)
  const edits: Array<{ path: string[]; value: unknown }> = []
  if (updates.defaultModel !== undefined) edits.push({ path: ['env', 'ANTHROPIC_DEFAULT_MODEL'], value: updates.defaultModel })
  if (updates.modelPicker !== undefined) edits.push({ path: ['modelPicker'], value: updates.modelPicker })
  if (updates.fallbackModel !== undefined) edits.push({ path: ['fallbackModel'], value: updates.fallbackModel })
  if (!edits.length) return text
  const expected = JSON.parse(text) as Record<string, unknown>
  if (updates.defaultModel !== undefined) ensureRecord(expected, 'env').ANTHROPIC_DEFAULT_MODEL = updates.defaultModel
  if (updates.modelPicker !== undefined) expected.modelPicker = updates.modelPicker
  if (updates.fallbackModel !== undefined) expected.fallbackModel = updates.fallbackModel
  const indentation = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  '
  const formattingOptions = {
    insertSpaces: !indentation.startsWith('\t'),
    tabSize: indentation.startsWith('\t') ? 1 : indentation.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  }
  let content = text
  for (const edit of edits) content = applyEdits(content, modify(content, edit.path, edit.value, { formattingOptions }))
  try {
    return isDeepStrictEqual(JSON.parse(content), expected) ? content : 'unlocated'
  } catch {
    return 'unlocated'
  }
}

/**
 * 在 config.toml 顶层补上本软件那一行，其余一个字不动：放在第一张表之前最后一个键的后面。补进去
 * 读回来必须恰好只多了这一个键（防的是多行字符串、多行数组里刚好有一行像表头），对不上就换到
 * 第一张表正前面、文件开头再试，都不行给 null。
 */
function withManagedCodexModelCatalogLine(text: string): string | null {
  const expected = parseTomlOrNull(text)
  if (!expected || expected.model_catalog_json !== undefined) return null
  expected.model_catalog_json = codexModelCatalogFileName
  const lines = text.split(/(?<=\n)/)
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line))
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable
  let afterLastKey = 0
  for (let index = 0; index < topLevelEnd; index += 1) {
    if (/^\s*[^\s#]/.test(lines[index])) afterLastKey = index + 1
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const line = `model_catalog_json = ${tomlString(codexModelCatalogFileName)}${eol}`
  for (const at of new Set([afterLastKey, topLevelEnd, 0])) {
    const before = lines.slice(0, at).join('')
    const next = `${before}${before && !before.endsWith('\n') ? eol : ''}${line}${lines.slice(at).join('')}`
    const reread = parseTomlOrNull(next)
    if (reread && isDeepStrictEqual(reread, expected)) return next
  }
  return null
}

// 模板改进只在「保存配置」那几条路上落盘，而老客户开机走的是恢复账号、一个字不写，
// 于是 0.2.7 之后加进模板的那些项（Codex 关统计、Windows 沙箱不弹管理员框、Claude Code
// 读网页不问官方、Gemini 不自己升级、Grok 出图走当前账号……）他们一项都没拿到。
//
// 这个号记在工具配置来源记录里（tool-config-ownership.ts）：记录落后于它、来源又确认是
// 当前账号的配置，开机时由 fillRelayTemplateDefaults 补一次缺省项。往下面那几个
// fill*RelayTemplateDefaults 里加了新的一项，就把这个号加一，否则老客户拿不到。
// 2：Claude Code 没写权限模式的补「不逐条确认」（2026-10-06）。
// 3：Codex 线路显示名老模板的 XingmangAI 换成 OpenAI（2026-10-14）。这一项改的是值不是缺省
//    键，只认星芒自己那张表上一字不差的老值（renameLegacyCodexRelayDisplayName）。
// 4：Codex 星芒那张表没写 supports_websockets 的按型号补，GPT 型号 true、别家型号 false（2026-10-16）。
// 5：VS Code、Cursor 的用户设置没写 claudeCode.disableLoginPrompt 的补 true（2026-10-26）。这一项不在
//    Claude Code 自己的配置里，由开机补设置那一轮在 Claude Code 那份到期时顺带做（editor-claude-login-prompt.ts）。
// 6：Codex、Grok 配置目录里一份全局说明都没有的，放一份「用中文回复」（2026-10-26）。这一项不是
//    配置里的键，是另放一个文件（globalResponseLanguagePlans），同一次两阶段提交里写。
export const relayTemplateRevision = 6

function fillCodexRelayTemplateDefaults(parsed: Record<string, unknown>, siteBaseUrl: string, platform: NodeJS.Platform): void {
  if (parsed.check_for_update_on_startup === undefined) parsed.check_for_update_on_startup = false
  if (parsed.approval_policy === undefined) parsed.approval_policy = 'on-request'
  if (parsed.sandbox_mode === undefined) parsed.sandbox_mode = 'workspace-write'
  if (parsed.analytics === undefined || isJsonRecord(parsed.analytics)) disableCodexRelayAnalytics(parsed)
  dropDeprecatedCodexConfigKeys(parsed)
  applyCodexRelayMachineDefaults(parsed, platform)
  const active = typeof parsed.model_provider === 'string' ? parsed.model_provider.trim() : ''
  const entry = active && isJsonRecord(parsed.model_providers) ? parsed.model_providers[active] : null
  if (isJsonRecord(entry)) renameLegacyCodexRelayDisplayName(entry, siteBaseUrl)
  if (isJsonRecord(entry) && isOwnCodexRelayEntry(entry, siteBaseUrl) && entry.supports_websockets === undefined
    && typeof parsed.model === 'string') {
    entry.supports_websockets = codexModelUsesRelayWebsockets(parsed.model)
  }
}

function fillClaudeRelayTemplateDefaults(parsed: Record<string, unknown>): void {
  const env = fillableRecord(parsed, 'env')
  if (env && env.DISABLE_AUTOUPDATER === undefined) disableClaudeSelfUpdate(env)
  const permissions = fillableRecord(parsed, 'permissions')
  if (permissions && (permissions.deny === undefined || Array.isArray(permissions.deny))) denyClaudeRelayTool(permissions)
  if (permissions) skipClaudeCommandConfirmation(parsed, permissions)
  if (parsed.skipWebFetchPreflight === undefined) skipClaudeWebFetchPreflight(parsed)
  ensureClaudeResponseLanguage(parsed)
  extendClaudeSessionRetention(parsed)
}

function fillGrokRelayTemplateDefaults(parsed: Record<string, unknown>, relayBaseUrl: string, relayModelName: string): void {
  const cli = fillableRecord(parsed, 'cli')
  if (cli && cli.auto_update === undefined) disableGrokSelfUpdate(parsed)
  const endpoints = fillableRecord(parsed, 'endpoints')
  if (endpoints && endpoints.xai_api_base_url === undefined) pointGrokXaiApiAtRelay(parsed, relayBaseUrl)
  if (isJsonRecord(parsed.models)) pinGrokModelsToRelay(parsed, relayModelName)
}

/** 空表是 fillableRecord 为了看一眼建出来的，没往里补东西就拿掉，免得凭空多一张表。 */
function dropEmptyCreatedTables(parsed: Record<string, unknown>, before: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (before[key] === undefined && isJsonRecord(value) && Object.keys(value).length === 0) delete parsed[key]
  }
}

function relayTemplateDefaultsPlans(
  provider: ProviderId,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
  platform: NodeJS.Platform,
  seeded: SeededToolDefaults,
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  switch (provider) {
    case 'codex': {
      const snapshots = codexConfigSnapshotPaths(roots)
      const text = requireConfigText(snapshots.active, '现有 Codex config.toml')
      if (text === null) return []
      const parsed = requireToml(snapshots.active, '现有 Codex config.toml')
      if (classifyCodexConfigProfile(parsed, siteBaseUrls.codex) !== 'relay') return []
      const before = cloneTomlRecord(parsed)
      fillCodexRelayTemplateDefaults(parsed, siteBaseUrls.codex, platform)
      dropEmptyCreatedTables(parsed, before)
      const language = globalResponseLanguagePlans(provider, roots, seeded)
      if (JSON.stringify(parsed) === JSON.stringify(before)) return language
      const content = tomlContent(parsed)
      return [{ path: snapshots.relay, content }, { path: snapshots.active, content }, ...language]
    }
    case 'claude': {
      if (requireConfigText(paths[0], '现有 Claude settings.json') === null) return []
      const parsed = requireJson(paths[0], '现有 Claude settings.json')
      if (normalizeUrl(nestedString(parsed, ['env', 'ANTHROPIC_BASE_URL'])) !== normalizeUrl(siteBaseUrls.claude)) return []
      const before = structuredClone(parsed)
      fillClaudeRelayTemplateDefaults(parsed)
      dropEmptyCreatedTables(parsed, before)
      if (JSON.stringify(parsed) === JSON.stringify(before)) return []
      return [{ path: paths[0], content: jsonContent(parsed) }]
    }
    case 'gemini': {
      const { parsed, original } = requireGeminiJson(paths[0], '现有 Gemini settings.json')
      if (original === null) return []
      if (nestedString(parsed, ['security', 'auth', 'selectedType']) !== 'gemini-api-key') return []
      if (normalizeUrl(readEnvValue(paths[1], 'GOOGLE_GEMINI_BASE_URL')) !== normalizeUrl(siteBaseUrls.gemini)) return []
      const before = structuredClone(parsed)
      fillGeminiRelayTemplateDefaults(parsed, geminiCliCompatibleModel(readEnvValue(paths[1], 'GEMINI_MODEL')))
      dropEmptyCreatedTables(parsed, before)
      if (JSON.stringify(parsed) === JSON.stringify(before)) return []
      const statisticsAdded = geminiUsageStatisticsSetting(before) === undefined && geminiUsageStatisticsSetting(parsed) === false
      return [
        ...(statisticsAdded ? geminiUsageStatisticsRecordPlans(roots) : []),
        { path: paths[0], content: geminiJsonContent(original, parsed) },
      ]
    }
    case 'grok': {
      if (requireConfigText(paths[0], '现有 Grok config.toml') === null) return []
      const parsed = requireToml(paths[0], '现有 Grok config.toml')
      const defaultModel = nestedString(parsed, ['models', 'default'])
      const tables = parsed.model
      const table = defaultModel && isJsonRecord(tables) ? tables[defaultModel] : null
      const tableBaseUrl = isJsonRecord(table) && typeof table.base_url === 'string' ? table.base_url : ''
      if (!tableBaseUrl || normalizeUrl(tableBaseUrl) !== normalizeUrl(siteBaseUrls.grok)) return []
      const before = cloneTomlRecord(parsed)
      fillGrokRelayTemplateDefaults(parsed, siteBaseUrls.grok, defaultModel)
      dropEmptyCreatedTables(parsed, before)
      const language = globalResponseLanguagePlans(provider, roots, seeded)
      if (JSON.stringify(parsed) === JSON.stringify(before)) return language
      return [{ path: paths[0], content: tomlContent(parsed) }, ...language]
    }
  }
}

/** 这份配置还缺不缺模板里的项。只读；不是指向当前账号服务的配置一律算「不缺」。 */
export function relayTemplateDefaultsPending(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots,
  siteBaseUrlsInput: Record<ProviderId, string>,
  platform: NodeJS.Platform = process.platform,
  seeded: SeededToolDefaults = {},
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  for (const filePath of providerConfigPaths(provider, roots)) assertSafeConfigPath(filePath, providerRoot, 'file')
  return relayTemplateDefaultsPlans(provider, roots, siteBaseUrlsInput, platform, seeded).length > 0
}

/**
 * 给一份「当前账号的」配置只补模板里缺的那几项：键缺省才写，用户写过的值（哪怕写的是
 * false）一律不动，Key、服务地址、型号、钩子、状态行这些也都不碰。唯一换值的是 Codex
 * 线路显示名：只换星芒自己那张表上一字不差的老模板值 XingmangAI（第 3 版）。Codex、Grok 的配置
 * 目录里一份全局说明都没有时另放一份「用中文回复」（第 6 版）。配置不是指向当前
 * 账号服务的（切回了官方、换了别家）就什么都不做。写入与保存配置同一套两阶段提交、
 * 留 .bak、失败回滚（I9）。返回 null = 这份配置已经齐了，没写任何文件。
 */
export function fillRelayTemplateDefaults(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots,
  siteBaseUrlsInput: Record<ProviderId, string>,
  hooks: NativeConfigWriteHooks = {},
  platform: NodeJS.Platform = process.platform,
  seeded: SeededToolDefaults = {},
): NativeConfigSaveResult | null {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  for (const filePath of providerConfigPaths(provider, roots)) assertSafeConfigPath(filePath, providerRoot, 'file')
  const plans = relayTemplateDefaultsPlans(provider, roots, siteBaseUrlsInput, platform, seeded)
  if (plans.length === 0) return null
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}

/** 给已经在官方账号上的 Codex 配置补旧对话要的那张表；读不懂的配置不碰（那是重置的事）。 */
function codexOfficialAliasPlans(roots: ProviderConfigRoots, siteBaseUrls: Record<ProviderId, string>): FilePlan[] {
  const snapshots = codexConfigSnapshotPaths(roots)
  const text = requireConfigText(snapshots.active, '现有 Codex config.toml')
  if (!text) return []
  if (classifyCodexConfigProfile(parseTomlOrNull(text), siteBaseUrls.codex) !== 'official') return []
  const providerName = activeCodexRelayProviderName(readStoredCodexRelayConfigOrNull(snapshots.relay), siteBaseUrls.codex)
  const content = withOfficialCodexAlias(text, providerName, siteBaseUrls.codex)
  return content === text ? [] : [{ path: snapshots.active, content }]
}

/** 已经在官方账号上的 Codex 配置缺不缺旧对话要的那张表（这次以前切官方时删掉了）。只读。 */
export function codexOfficialAliasPending(
  rootsInput: ProviderConfigRoots,
  siteBaseUrlsInput: Record<ProviderId, string>,
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('codex', roots)
  for (const filePath of providerConfigPaths('codex', roots)) assertSafeConfigPath(filePath, providerRoot, 'file')
  return codexOfficialAliasPlans(roots, siteBaseUrlsInput).length > 0
}

/**
 * 这次以前切到官方账号的客户，config.toml 里已经没有旧对话记着的那张表，不再切一遍就一直
 * 打不开。这里给他们补上同一张走官方登录的表（见 officialCodexAliasEntry）：只加这一张，
 * 别的一个字不动；星芒没存过当前账号配置、表已经在、同名表是客户自己的都什么也不做。写入与
 * 保存配置同一套两阶段提交、留 .bak、失败回滚（I9）。返回 null = 没写任何文件。
 */
export function restoreCodexOfficialAlias(
  rootsInput: ProviderConfigRoots,
  siteBaseUrlsInput: Record<ProviderId, string>,
  hooks: NativeConfigWriteHooks = {},
): NativeConfigSaveResult | null {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('codex', roots)
  for (const filePath of providerConfigPaths('codex', roots)) assertSafeConfigPath(filePath, providerRoot, 'file')
  const plans = codexOfficialAliasPlans(roots, siteBaseUrlsInput)
  if (plans.length === 0) return null
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}

export function inspectCodexWorkspacePermissions(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  workspace: string,
): CodexWorkspacePermissionStatus {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const configPath = codexConfigSnapshotPaths(roots).active
  const providerRoot = path.dirname(configPath)
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const content = fs.existsSync(configPath)
    ? requireConfigText(configPath, '现有 Codex config.toml')
    : null
  return inspectCodexWorkspacePermissionsText(content, workspace, configPath)
}

export function trustCodexWorkspace(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  workspace: string,
): CodexWorkspacePermissionWriteResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const configPath = codexConfigSnapshotPaths(roots).active
  const providerRoot = path.dirname(configPath)
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const current = fs.existsSync(configPath)
    ? requireConfigText(configPath, '现有 Codex config.toml')
    : null
  const next = trustCodexWorkspaceInConfigText(current, workspace)
  if (!next.changed) {
    return {
      backups: [],
      files: [],
      changed: false,
      status: inspectCodexWorkspacePermissionsText(current, workspace, configPath),
    }
  }
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  const saved = executeFilePlans([{ path: configPath, content: next.content }], {}, providerRoot)
  return {
    ...saved,
    changed: true,
    status: inspectCodexWorkspacePermissionsText(next.content, workspace, configPath),
  }
}

/** Source snapshots must be migrated together so an account switch cannot restore old limits. */
export function removeCodexContextLimitsFromConfigs(
  rootsInput: ProviderConfigRoots,
  hooks: NativeConfigWriteHooks = {},
): NativeConfigSaveResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('codex', roots)
  const plans: FilePlan[] = []
  for (const configPath of Object.values(codexConfigSnapshotPaths(roots))) {
    assertSafeConfigPath(configPath, providerRoot, 'file')
    const content = readSafeUtf8FileSync(configPath, 'Codex 配置', MAX_NATIVE_CONFIG_BYTES)
    if (content === null) continue
    const next = removeCodexContextLimits(content)
    if (next.changed) plans.push({ path: configPath, content: next.content })
  }
  if (plans.length === 0) return { backups: [], files: [] }
  return executeFilePlans(plans, hooks, providerRoot)
}

/** Adds safe, interactive defaults to an existing Codex config without touching credentials. */
export function ensureCodexPermissionDefaults(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): NativeConfigSaveResult & { changed: boolean } {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const configPath = codexConfigSnapshotPaths(roots).active
  const providerRoot = path.dirname(configPath)
  assertSafeConfigPath(configPath, providerRoot, 'file')
  if (!fs.existsSync(configPath)) return { backups: [], files: [], changed: false }
  const current = requireConfigText(configPath, '现有 Codex config.toml')
  if (current === null) return { backups: [], files: [], changed: false }
  const next = ensureCodexPermissionDefaultsInConfigText(current)
  if (!next.changed) return { backups: [], files: [], changed: false }
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  const saved = executeFilePlans([{ path: configPath, content: next.content }], {}, providerRoot)
  return { ...saved, changed: true }
}

// ---------------------------------------------------------------------------
// 钩子与状态行指向旧位置
//
// 卸载后换个文件夹重装、Mac 上挪了 app、换装了 Node.js，写在配置里的绝对路径就失效了
// （cli-hooks.ts 那段说明）。这里只读出、只重写、只收回本软件那几条，Key、模型和用户
// 自己写的钩子一个字不动；写入照旧两阶段提交 + .bak（I9）。
// ---------------------------------------------------------------------------

/** 某家配置里本软件的钩子、状态行、Codex notify 各自指向哪里。读不出来就当没有。 */
export function inspectManagedCliHookTargets(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): ManagedCliHookTarget[] {
  const configPath = providerConfigPaths(provider, rootsInput)[0]
  const parsed = provider === 'gemini' ? readGeminiJson(configPath)
    : provider === 'claude' ? readJson(configPath)
    : readToml(configPath)
  if (!parsed) return []
  const targets = managedCliHookTargets(provider, parsed)
  if (provider === 'claude') {
    const statusLine = managedClaudeStatusLineTarget(parsed)
    if (statusLine) targets.push(statusLine)
  }
  return targets
}

export interface ManagedCliHookRewrite {
  /** 缺省 = 这台电脑现在写不出钩子（没有 Node.js 之类），那就把我们那几条收回，不再报错。 */
  cliHook?: CliHookInvocation
  /** 同上，只给 Claude Code。 */
  claudeStatusLineCommand?: string
  /**
   * 只给 Grok：原来一条都没写（Windows 上只装 Grok 时没有运行环境）也按 cliHook 补上。
   * 缺省 = 旧行为，没写过的不补。
   */
  addIfMissing?: boolean
}

/**
 * 只动本软件那几条：原来有才改，改成这次的路径；这次写不出来就收回。原来没有的
 * 不补——那是「没写过」而不是「指向旧位置」，补不补归保存配置那条路管。
 */
function managedCliHookPlan(
  provider: ProviderId,
  roots: ProviderConfigRoots,
  rewrite: ManagedCliHookRewrite | null,
): FilePlan | null {
  const configPath = providerConfigPaths(provider, roots)[0]
  switch (provider) {
    case 'claude': {
      const original = requireConfigText(configPath, '现有 Claude settings.json')
      if (original === null) return null
      const parsed = requireJson(configPath, '现有 Claude settings.json')
      let changed = false
      if (managedCliHookTargets('claude', parsed).length > 0) {
        removeClaudeCliHooks(parsed)
        if (rewrite?.cliHook) applyClaudeCliHooks(parsed, rewrite.cliHook)
        changed = true
      }
      if (managedClaudeStatusLineTarget(parsed)) {
        if (rewrite?.claudeStatusLineCommand) applyClaudeStatusLine(parsed, rewrite.claudeStatusLineCommand)
        else delete parsed.statusLine
        changed = true
      }
      return changed ? { path: configPath, content: jsonContent(parsed) } : null
    }
    case 'gemini': {
      const { parsed, original } = requireGeminiJson(configPath, '现有 Gemini settings.json')
      if (original === null || managedCliHookTargets('gemini', parsed).length === 0) return null
      removeGeminiCliHooks(parsed)
      if (rewrite?.cliHook) applyGeminiCliHooks(parsed, rewrite.cliHook)
      return { path: configPath, content: geminiJsonContent(original, parsed) }
    }
    case 'codex': {
      if (requireConfigText(configPath, '现有 Codex config.toml') === null) return null
      const parsed = requireToml(configPath, '现有 Codex config.toml')
      if (managedCliHookTargets('codex', parsed).length === 0) return null
      if (rewrite?.cliHook) applyCodexCliNotify(parsed, rewrite.cliHook)
      else removeCodexCliNotify(parsed)
      return { path: configPath, content: tomlContent(parsed) }
    }
    case 'grok': {
      if (requireConfigText(configPath, '现有 Grok config.toml') === null) return null
      const parsed = requireToml(configPath, '现有 Grok config.toml')
      if (managedCliHookTargets('grok', parsed).length === 0) {
        // 只装 Grok、当时没有运行环境，钩子一条没写；后来有了就补上（addIfMissing）。
        // 补不出来（推到 cmd）就别动文件，免得每次都白白多一份备份。
        if (!rewrite?.addIfMissing || !rewrite.cliHook || grokCliHookCommand(rewrite.cliHook) === null) return null
      }
      removeGrokCliHooks(parsed)
      if (rewrite?.cliHook) applyGrokCliHooks(parsed, rewrite.cliHook)
      return { path: configPath, content: tomlContent(parsed) }
    }
  }
}

function executeManagedCliHookPlan(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots,
  rewrite: ManagedCliHookRewrite | null,
): NativeConfigSaveResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  for (const filePath of providerConfigPaths(provider, roots)) assertSafeConfigPath(filePath, providerRoot, 'file')
  const plan = managedCliHookPlan(provider, roots, rewrite)
  if (!plan) return { backups: [], files: [] }
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans([plan], {}, providerRoot)
}

/** 首页「修好它」：把本软件那几条改成这次的路径（写不出来就收回），其余原样。 */
export function rewriteManagedCliHooks(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots,
  rewrite: ManagedCliHookRewrite,
): NativeConfigSaveResult {
  return executeManagedCliHookPlan(provider, rootsInput, rewrite)
}

/** 卸载时收回本软件写进这家配置的钩子与状态行。Key 和其余设置留着，卸了星芒工具照样能用。 */
export function removeManagedCliHooks(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): NativeConfigSaveResult {
  return executeManagedCliHookPlan(provider, rootsInput, null)
}

// ---------------------------------------------------------------------------
// 账号来源切换:星芒中转 ⇄ 用户自己的官方订阅
//
// 产品背景(2026-08-12 老板决策):不做本机双路由常驻服务,改为"一键切回
// 自己的订阅账号"。Codex 的两种 auth.json 不能混写:
//   - 星芒中转 = 只有 OPENAI_API_KEY
//   - ChatGPT 账号 = auth_mode + tokens + last_refresh
// 切换前把当前这份存到 xingmang-auth-*.json / xingmang-config-*.toml,
// 切回来整份换上,tokens 不进渲染进程。Claude / Gemini 仍只收回我们写进去的键。
// 双向都走同一套两阶段提交 + .bak(I9),切回星芒 = 现有 saveProviderConfig。
// ---------------------------------------------------------------------------

export type ProviderAccountMode = 'relay' | 'official' | 'unknown'

/**
 * 当前这个 CLI 在用谁的账号。`unknown` = 配了 Key 但 base URL 不是星芒
 * (用户自己接了别家中转),此时切换会拒绝执行,免得把别人的配置抹掉。
 */
export function providerAccountMode(
  inspection: Pick<NativeConfigInspection, 'hasApiKey' | 'matchesRelay'>,
): ProviderAccountMode {
  if (inspection.matchesRelay) return 'relay'
  if (!inspection.hasApiKey) return 'official'
  return 'unknown'
}

/** 星芒中转和官方账号都能启动；自定义第三方地址不行。 */
export function canLaunchManagedProvider(
  inspection: Pick<NativeConfigInspection, 'hasApiKey' | 'matchesRelay'>,
): boolean {
  const mode = providerAccountMode(inspection)
  return mode === 'relay' || mode === 'official'
}

export function managedProviderLaunchBlockedMessage(provider: ProviderId): string {
  switch (provider) {
    case 'codex':
      return 'Codex 当前用的是自定义接口，请先切到星芒中转或 ChatGPT 账号'
    case 'claude':
      return 'Claude 当前用的是自定义接口，请先切到星芒中转或 Claude 账号'
    case 'gemini':
      return 'Gemini 当前用的是自定义接口，请先切到星芒中转或 Google 账号'
    case 'grok':
      return 'Grok 当前用的是自定义接口，请先切到星芒中转或 Grok 账号'
  }
}

// 读不懂时指路那句里的工具名，用首页那一行的叫法；Codex CLI 和桌面端共用一份配置，就叫「Codex」。
const brokenConfigToolNames: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  grok: 'Grok CLI',
}

/**
 * merge 只处理已存在的配置；显式 reset 可以建立当前账号来源的初始配置。
 * 官方登录和历史数据均独立保留，不属于重置范围。
 */
function createOfficialAccountPlans(
  provider: ProviderId,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
  mode: NativeConfigSaveMode,
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  switch (provider) {
    case 'codex':
      return [
        ...createCodexOfficialConfigPlans(roots, siteBaseUrls, mode),
        ...createCodexOfficialAuthPlans(roots, mode),
      ]
    case 'claude': {
      // 切回官方账号不收回自动更新开关：CLI 仍由本软件装、也由本软件更新。语言与记录
      // 保留期同理——它们是用户偏好，跟用哪个账号无关，reset 重建时一并写回，否则换回
      // 官方账号的用户会悄悄回到 30 天自动删。
      if (mode === 'reset') {
        const settings: Record<string, unknown> = {
          env: { DISABLE_AUTOUPDATER: '1' },
          language: MANAGED_CLAUDE_RESPONSE_LANGUAGE,
          cleanupPeriodDays: MANAGED_CLAUDE_RETENTION_DAYS,
        }
        const restore = claudeForeignSettingsRestorePlans(settings, roots)
        return [...restore, { path: paths[0], content: jsonContent(settings) }]
      }
      if (!fs.existsSync(paths[0])) return []
      const parsed = requireJson(paths[0], '现有 Claude settings.json', brokenConfigToolNames.claude)
      const env = parsed.env
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        const envRecord = env as Record<string, unknown>
        delete envRecord.ANTHROPIC_AUTH_TOKEN
        delete envRecord.ANTHROPIC_BASE_URL
        removeClaudeRelayModelPicker(parsed, envRecord)
        if (Object.keys(envRecord).length === 0) delete parsed.env
      } else {
        removeClaudeRelayModelPicker(parsed, null)
      }
      allowClaudeRelayTool(parsed)
      // 通知里说的是「当前账号」，官方账号出错时那些话都不对，钩子跟着收回。
      removeClaudeCliHooks(parsed)
      delete parsed.skipWebFetchPreflight
      delete parsed.model
      const restore = claudeForeignSettingsRestorePlans(parsed, roots)
      return [...restore, { path: paths[0], content: jsonContent(parsed) }]
    }
    case 'gemini': {
      const statisticsRecord = readGeminiUsageStatisticsRecord(roots)
      if (mode === 'reset') {
        return [
          ...geminiUsageStatisticsRecordClearPlans(statisticsRecord, roots),
          {
            path: paths[0],
            content: jsonContent({
              general: {
                enableAutoUpdate: false,
                enableAutoUpdateNotification: false,
                sessionRetention: { maxAge: MANAGED_GEMINI_SESSION_MAX_AGE },
              },
              security: { auth: { selectedType: 'oauth-personal' } },
            }),
          },
          ...(fs.existsSync(paths[1]) ? [{ path: paths[1], content: '' }] : []),
        ]
      }
      const plans: FilePlan[] = []
      if (fs.existsSync(paths[0])) {
        const { parsed, original } = requireGeminiJson(paths[0], '现有 Gemini settings.json', brokenConfigToolNames.gemini)
        const auth = ensureRecord(ensureRecord(parsed, 'security'), 'auth')
        auth.selectedType = 'oauth-personal'
        removeGeminiRelayModelOverrides(parsed)
        restoreGeminiUsageStatistics(parsed, geminiUsageStatisticsWrittenByUs(statisticsRecord))
        removeGeminiCliHooks(parsed)
        plans.push(...geminiUsageStatisticsRecordClearPlans(statisticsRecord, roots))
        plans.push({ path: paths[0], content: geminiJsonContent(original, parsed) })
      }
      const envContent = requireConfigText(paths[1], '现有 Gemini .env')
      if (envContent !== null) {
        plans.push({
          path: paths[1],
          content: removeEnvEntries(envContent, ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY', 'GEMINI_MODEL']),
        })
      }
      return plans
    }
    case 'grok': {
      if (mode === 'reset') return [{ path: paths[0], content: ['[cli]', 'auto_update = false', ''].join('\n') }]
      if (!fs.existsSync(paths[0])) return []
      const parsed = requireToml(paths[0], '现有 Grok config.toml', brokenConfigToolNames.grok)
      removeGrokRelayConfig(parsed, siteBaseUrls.grok)
      disableGrokSelfUpdate(parsed)
      // 与 Claude / Gemini 同理钩子跟着收回；[compat.claude] 那一行留着，Claude Code 可能还接着当前账号。
      removeGrokCliHooks(parsed)
      return [{ path: paths[0], content: tomlContent(parsed) }]
    }
  }
}

/**
 * 把某个 CLI 切回用户自己的官方订阅账号。返回值与 saveProviderConfig 同形,
 * 调用方拿到的是同一套备份/写入清单。
 *
 * 第三方中转配置保持拒绝；显式 reset 也允许重建已经处于官方来源的配置。
 */
export function switchProviderToOfficialAccount(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  hooks: NativeConfigWriteHooks = {},
  siteBaseUrlsInput: Record<ProviderId, string> = providerBaseUrls,
  saveMode: NativeConfigSaveMode = 'merge',
): NativeConfigSaveResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const configuredPaths = providerConfigPaths(provider, roots)
  for (const filePath of configuredPaths) assertSafeConfigPath(filePath, providerRoot, 'file')

  const inspection = inspectProviderConfig(provider, roots, siteBaseUrlsInput)
  // Codex 自己的 ChatGPT 登录会把 auth.json 换成令牌、Key 置空，却不动 config.toml；
  // 切账号站点也会让现有中转地址不同于当前站点。两种情况都必须按已知中转来源
  // 切回，才能同时恢复官方 config.toml 与 auth.json。
  const knownCodexRelay = provider === 'codex'
    && isKnownCodexRelayBaseUrl(inspection.actualBaseUrl, siteBaseUrlsInput.codex)
  // 登录 ChatGPT 换来的那把 Key 常和令牌一起留在 auth.json 里（auth_mode 说了算，Codex 不用它），
  // config.toml 又坏到 Codex 读不了：看着像「有 Key、地址不是星芒」的第三方，其实用的就是官方
  // 账号。首页「配置文件坏了」的「修好它」走的是这条重置，先备份，坏文件里没有能用的设置可护。
  const brokenChatgptLogin = provider === 'codex' && saveMode === 'reset'
    && inspection.configBroken === true && inspection.codexAuthMode === 'chatgpt'
  const mode = knownCodexRelay ? 'relay' : brokenChatgptLogin ? 'official' : providerAccountMode(inspection)
  // 工具自己读不了的文件，读出来的「没有 Key」不说明在用官方账号（Claude Code 的 settings.json
  // 坏了以前就被说成「无需切换」）。只更新要照着原文件改，指去重置；认得出是星芒中转的照常往下走，
  // 读不懂的那一份由下面的计划报同一句。
  if (mode !== 'relay' && saveMode !== 'reset' && (inspection.configBroken === true || inspection.codexAuthBroken === true)) {
    throw new Error(describeBrokenConfig(brokenConfigToolNames[provider]))
  }
  if (mode === 'official' && saveMode !== 'reset') throw new Error('当前已经在使用你自己的官方订阅账号，无需切换')
  if (mode === 'unknown') {
    throw new Error('当前配置不是星芒中转（可能是你自己填的第三方地址），为避免改坏配置已取消切换')
  }

  const plans = createOfficialAccountPlans(provider, roots, siteBaseUrlsInput, saveMode)
  if (plans.length === 0) throw new Error('没有找到可切换的配置文件')

  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}

// ---------------------------------------------------------------------------
// 别家中转留下的 Claude 设置
//
// 照 GLM、Kimi 或别家中转的教程配过 Claude Code 的人，~/.claude/settings.json
// 里常留着这几项。合并写入只换 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / model，
// 它们原样留下就会顶掉当前账号：ANTHROPIC_API_KEY 与 apiKeyHelper 让请求多带一把
// 别人的 Key（new-api 拿 x-api-key 顶掉 Authorization，见 diagnostics.ts 那段实测），
// ANTHROPIC_MODEL 压过 model，其余几项把 Haiku / Sonnet / Opus 别名映射到当前账号
// 没有的型号。界面却照样显示「正常」（全面检测 Q7）。
//
// 接当前账号时把它们挪进旁边的快照文件，切回官方账号时原样放回。和 settings.json
// 在同一次两阶段提交里写，不会一边有一边没有。ANTHROPIC_DEFAULT_MODEL 不在这张表
// 里：它是本软件自己的选模型菜单写的（claude-model-picker.ts）。
// ---------------------------------------------------------------------------

export const claudeForeignSettingsSnapshotName = 'xingmang-claude-foreign-settings.json'

const claudeForeignEnvKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  // CC Switch 给每个供应商都会写这两项。Claude Code 2.1.277 实测 `--model fable`
  // 照样被 ANTHROPIC_DEFAULT_FABLE_MODEL 改道去别家的型号名；子任务的型号由
  // CLAUDE_CODE_SUBAGENT_MODEL 指定，同理。
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const
const claudeForeignTopLevelKeys = ['apiKeyHelper'] as const

/**
 * 上面选型号的那几项。客户在系统设置或 ~/.zshrc 里设的同名环境变量 Claude Code 一样认，所以用星芒账号
 * 从星芒打开 Claude Code 时也不交给它（provider-launch-service.ts 的 launchExcludedEnvironmentVariables，已知45 跟进），
 * 范围靠这一处和这里挪开的对齐。ANTHROPIC_API_KEY 不在内：它换的是 Key 不是型号，从星芒打开时不带它的是
 * launchExcludedEnvironmentVariables 另外列的那一项，三个平台一样（#1081）。
 */
export const claudeForeignModelEnvKeys: readonly string[] = claudeForeignEnvKeys.filter((key) => key !== 'ANTHROPIC_API_KEY')

interface ClaudeForeignSettings {
  env: Record<string, unknown>
  settings: Record<string, unknown>
}

function readClaudeForeignSnapshot(content: string | null): ClaudeForeignSettings {
  const parsed = requireWorkspaceTrustJson(content, '已保存的 Claude 旧设置')
  return {
    env: isJsonRecord(parsed.env) ? { ...parsed.env } : {},
    settings: isJsonRecord(parsed.settings) ? { ...parsed.settings } : {},
  }
}

function claudeForeignSnapshotContent(snapshot: ClaudeForeignSettings): string {
  return Object.keys(snapshot.env).length === 0 && Object.keys(snapshot.settings).length === 0
    ? ''
    : jsonContent({ version: 1, env: snapshot.env, settings: snapshot.settings })
}

/**
 * 纯函数：把 settings 里会顶掉当前账号的几项挪进快照（会改 settings）。返回新的
 * 快照内容；null = 没有可挪的，快照不用动。settings 里又出现了同一项（用户在这
 * 期间自己改过）时以新值为准。值等于这次要写的 Key 的 ANTHROPIC_API_KEY 只删不存：
 * 放回官方那份配置等于把当前账号的 Key 塞给官方。
 */
export function moveClaudeForeignSettingsAside(
  settings: Record<string, unknown>,
  snapshotContent: string | null,
  relayApiKey: string,
): string | null {
  const env = isJsonRecord(settings.env) ? settings.env : null
  const envKeys = env ? claudeForeignEnvKeys.filter((key) => env[key] !== undefined) : []
  const topLevelKeys = claudeForeignTopLevelKeys.filter((key) => settings[key] !== undefined)
  if (envKeys.length === 0 && topLevelKeys.length === 0) return null
  const snapshot = readClaudeForeignSnapshot(snapshotContent)
  for (const key of envKeys) {
    const value = env![key]
    delete env![key]
    if (key === 'ANTHROPIC_API_KEY' && typeof value === 'string' && value.trim() === relayApiKey) continue
    snapshot.env[key] = value
  }
  for (const key of topLevelKeys) {
    snapshot.settings[key] = settings[key]
    delete settings[key]
  }
  if (env && Object.keys(env).length === 0) delete settings.env
  return claudeForeignSnapshotContent(snapshot)
}

/**
 * 纯函数：把快照里的几项放回 settings（会改 settings），返回是否放回过东西。已经
 * 有同名项（用户在这期间自己又设了）就以现有的为准。调用方随后清空快照。
 */
export function restoreClaudeForeignSettings(
  settings: Record<string, unknown>,
  snapshotContent: string | null,
): boolean {
  const snapshot = readClaudeForeignSnapshot(snapshotContent)
  let restored = false
  const envEntries = Object.entries(snapshot.env)
    .filter(([key]) => (claudeForeignEnvKeys as readonly string[]).includes(key))
  if (envEntries.length > 0) {
    const env = ensureRecord(settings, 'env')
    for (const [key, value] of envEntries) {
      if (env[key] !== undefined) continue
      env[key] = value
      restored = true
    }
  }
  for (const [key, value] of Object.entries(snapshot.settings)) {
    if (!(claudeForeignTopLevelKeys as readonly string[]).includes(key) || settings[key] !== undefined) continue
    settings[key] = value
    restored = true
  }
  return restored
}

function claudeForeignSnapshotPath(roots: ProviderConfigRoots): string {
  return path.join(providerConfigRoot('claude', roots), claudeForeignSettingsSnapshotName)
}

function readClaudeForeignSnapshotText(roots: ProviderConfigRoots): string | null {
  const snapshotPath = claudeForeignSnapshotPath(roots)
  assertSafeConfigPath(snapshotPath, providerConfigRoot('claude', roots), 'file')
  return requireConfigText(snapshotPath, '已保存的 Claude 旧设置')
}

/** 接当前账号时：把会顶掉当前账号的几项挪走，需要时附上快照文件的写入计划。 */
function claudeForeignSettingsAsidePlans(
  settings: Record<string, unknown>,
  existing: Record<string, unknown> | null,
  roots: ProviderConfigRoots,
  relayApiKey: string,
): FilePlan[] {
  // reset 从模板重建，原文件里的这几项要从 existing 里取；merge 时两者是同一个对象。
  const source = existing ?? settings
  const current = readClaudeForeignSnapshotText(roots)
  const snapshot = moveClaudeForeignSettingsAside(source, current, relayApiKey)
  // 只删掉了一把与这次相同的 Key、又本来没有快照时，不必为此建一个空文件。
  if (snapshot === null || (snapshot === '' && current === null)) return []
  return [{ path: claudeForeignSnapshotPath(roots), content: snapshot }]
}

/** 切回官方账号时：原样放回，并清空快照。没有快照就什么都不做。 */
function claudeForeignSettingsRestorePlans(settings: Record<string, unknown>, roots: ProviderConfigRoots): FilePlan[] {
  const content = readClaudeForeignSnapshotText(roots)
  if (content === null) return []
  restoreClaudeForeignSettings(settings, content)
  return content === '' ? [] : [{ path: claudeForeignSnapshotPath(roots), content: '' }]
}

// ---------------------------------------------------------------------------
// 切换时把会抢道的官方凭据挪到一边
//
// Claude Code 2.1.277 在 `ANTHROPIC_AUTH_TOKEN` 之外，还会把 `~/.claude.json` 的
// `primaryApiKey`（Anthropic Console 登录留下的 Key）以 `x-api-key` 同时发出去；
// new-api rc.24 在 `/v1/messages` 上用 `x-api-key` 覆盖 `Authorization`
// （middleware/auth.go），中转拿到的就是那把 Console Key，回 401。
// 切到当前账号时把它挪进旁边的快照文件，切回官方时放回原处。claude.ai 订阅
// 登录（.credentials.json / 钥匙串）不用挪：令牌一出现它就被整个忽略。
// ---------------------------------------------------------------------------

export const claudeConsoleKeySnapshotName = 'xingmang-claude-console-key.json'

export interface ClaudeConsoleKeyTexts {
  /** 改后的 ~/.claude.json；null = 不用改。 */
  rootConfig: string | null
  /** 改后的快照文件；null = 不用改。 */
  snapshot: string | null
}

function claudeRootConfigJson(content: string | null): Record<string, unknown> {
  return requireWorkspaceTrustJson(content, '现有 Claude Code ~/.claude.json')
}

function storedClaudeConsoleKey(content: string | null): string {
  if (!content?.trim()) return ''
  try {
    const parsed = JSON.parse(content) as unknown
    return isJsonRecord(parsed) && typeof parsed.primaryApiKey === 'string' ? parsed.primaryApiKey.trim() : ''
  } catch {
    return ''
  }
}

/** 纯函数：把 primaryApiKey 从根配置移进快照。没有可挪的就两边都不动。 */
export function moveClaudeConsoleKeyAsideTexts(rootContent: string | null): ClaudeConsoleKeyTexts {
  const parsed = claudeRootConfigJson(rootContent)
  const key = typeof parsed.primaryApiKey === 'string' ? parsed.primaryApiKey.trim() : ''
  if (!key) return { rootConfig: null, snapshot: null }
  delete parsed.primaryApiKey
  return { rootConfig: jsonContent(parsed), snapshot: jsonContent({ primaryApiKey: key }) }
}

/**
 * 纯函数：把快照里的 primaryApiKey 放回根配置并清空快照。根配置里已经有一把
 * （用户在这期间又登录了 Console）就以那把为准，只清快照。
 */
export function restoreClaudeConsoleKeyTexts(rootContent: string | null, snapshotContent: string | null): ClaudeConsoleKeyTexts {
  const stored = storedClaudeConsoleKey(snapshotContent)
  if (!stored) return { rootConfig: null, snapshot: null }
  const parsed = claudeRootConfigJson(rootContent)
  const current = typeof parsed.primaryApiKey === 'string' ? parsed.primaryApiKey.trim() : ''
  if (current) return { rootConfig: null, snapshot: '' }
  parsed.primaryApiKey = stored
  return { rootConfig: jsonContent(parsed), snapshot: '' }
}

function writeClaudeConsoleKeyTexts(
  rootsInput: ProviderConfigRoots,
  build: (rootContent: string | null, snapshotContent: string | null) => ClaudeConsoleKeyTexts,
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  // ~/.claude.json 与 ~/.claude/ 并列，事务根是主目录本身（同 trustClaudeWorkspace）。
  const root = roots.userHome
  const rootConfigPath = path.join(root, '.claude.json')
  const snapshotPath = path.join(providerConfigRoot('claude', roots), claudeConsoleKeySnapshotName)
  assertSafeConfigPath(rootConfigPath, root, 'file')
  assertSafeConfigPath(snapshotPath, root, 'file')
  const rootContent = requireConfigText(rootConfigPath, '现有 Claude Code ~/.claude.json', MAX_CLAUDE_ROOT_CONFIG_BYTES)
  const snapshotContent = requireConfigText(snapshotPath, '已保存的 Claude 官方 Key')
  const next = build(rootContent, snapshotContent)
  const plans: FilePlan[] = []
  if (next.snapshot !== null && (next.snapshot !== '' || snapshotContent !== null)) plans.push({ path: snapshotPath, content: next.snapshot })
  if (next.rootConfig !== null) plans.push({ path: rootConfigPath, content: next.rootConfig })
  if (plans.length === 0) return false
  assertNoReparseComponents(path.dirname(root), '用户主目录')
  ensureSafeDataDirectory(root, '用户主目录')
  ensureSafeDataDirectory(providerConfigRoot('claude', roots), 'Provider 配置根目录')
  // 快照先写：两阶段提交里任何一步失败都会整体回滚，Key 不会两边都没有。
  executeFilePlans(plans, {}, root)
  return true
}

/** 返回是否真的挪了一把 Key。 */
export function moveClaudeConsoleKeyAside(rootsInput: ProviderConfigRoots = defaultProviderConfigRoots()): boolean {
  return writeClaudeConsoleKeyTexts(rootsInput, (rootContent) => moveClaudeConsoleKeyAsideTexts(rootContent))
}

/** 返回是否改动了文件。 */
export function restoreClaudeConsoleKey(rootsInput: ProviderConfigRoots = defaultProviderConfigRoots()): boolean {
  return writeClaudeConsoleKeyTexts(rootsInput, restoreClaudeConsoleKeyTexts)
}

/**
 * 这台电脑上是否已经有这个 CLI 的官方登录。只看文件是否在、字段是否在，不读、
 * 不解码任何令牌。`null` = 看不出来（Codex 把登录放进系统凭据库时文件里没有）。
 * 用途只有一个：切回官方后告诉用户要不要自己再登录一次。
 */
export function inspectOfficialLogin(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): boolean | null {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  switch (provider) {
    case 'claude': {
      // macOS 把令牌放在钥匙串，但登录时同样会写 ~/.claude.json 的 oauthAccount；
      // /logout 会把它清掉，所以它是两个平台都靠得住的信号。
      const credentials = path.join(providerRoot, '.credentials.json')
      const rootConfig = path.join(roots.userHome, '.claude.json')
      assertSafeConfigPath(credentials, providerRoot, 'file')
      assertSafeConfigPath(rootConfig, roots.userHome, 'file')
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = claudeRootConfigJson(requireConfigText(rootConfig, '现有 Claude Code ~/.claude.json', MAX_CLAUDE_ROOT_CONFIG_BYTES))
      } catch {
        parsed = null
      }
      if (parsed && (isJsonRecord(parsed.oauthAccount) || (typeof parsed.primaryApiKey === 'string' && parsed.primaryApiKey.trim()))) return true
      return Boolean(readText(credentials)?.trim())
    }
    case 'codex': {
      const auth = readJson(providerConfigPaths('codex', roots)[1])
      const kind = classifyCodexAuthProfile(auth)
      if (kind === 'chatgpt' || kind === 'mixed') return true
      const store = nestedString(readToml(providerConfigPaths('codex', roots)[0]), ['cli_auth_credentials_store']).trim().toLowerCase()
      return store === 'keyring' || store === 'auto' ? null : false
    }
    case 'gemini': {
      const credentials = path.join(providerRoot, 'oauth_creds.json')
      assertSafeConfigPath(credentials, providerRoot, 'file')
      return Boolean(readText(credentials)?.trim())
    }
    case 'grok': {
      const credentials = path.join(providerRoot, 'auth.json')
      assertSafeConfigPath(credentials, providerRoot, 'file')
      return readGrokLogin(providerRoot) !== null
    }
  }
}
