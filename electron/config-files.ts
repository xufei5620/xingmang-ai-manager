import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as TOML from '@iarna/toml'
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { providerBaseUrls, type ProviderId } from './catalog'
import { relayProviderBaseUrlMatches, relaySites } from './relay-sites'
import { readBoundedFileSync, readBoundedUtf8FileSync } from './bounded-file'
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
import { applyClaudeRelayModelPicker, claudeRelayModelPickerOutdated, removeClaudeRelayModelPicker } from './claude-model-picker'
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
  renameWithTransientRetrySync,
} from './safe-local-data'
import { resolveRelocatedPath } from './relocated-folders'
import {
  applyXingmangImageMcpToJson,
  applyXingmangImageMcpToToml,
  applyXingmangImagePermissionToClaudeSettings,
  type XingmangImageMcpInvocation,
} from './xingmang-ai-mcp'

const MAX_NATIVE_CONFIG_BYTES = 2 * 1024 * 1024
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

function isRemovePlan(plan: FilePlan): plan is FileRemovePlan {
  return 'remove' in plan
}

function normalizeProviderConfigRoots(
  roots: ProviderConfigRoots = defaultProviderConfigRoots(),
): ProviderConfigRoots {
  return {
    userHome: path.resolve(roots.userHome),
    codexHome: path.resolve(roots.codexHome),
  }
}

export function providerConfigPaths(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): string[] {
  const root = providerConfigRoot(provider, normalizeProviderConfigRoots(rootsInput))
  switch (provider) {
    case 'codex':
      return [
        path.join(root, 'config.toml'),
        path.join(root, 'auth.json'),
      ]
    case 'claude':
      return [path.join(root, 'settings.json')]
    case 'gemini':
      return [
        path.join(root, 'settings.json'),
        path.join(root, '.env'),
      ]
    case 'grok':
      return [path.join(root, 'config.toml')]
  }
}

function readText(filePath: string): string | null {
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) return null
    return withoutByteOrderMark(readBoundedUtf8FileSync(filePath, MAX_NATIVE_CONFIG_BYTES, '配置文件'))
  } catch {
    return null
  }
}

/**
 * Notepad on older Windows and PowerShell 5's `Set-Content -Encoding UTF8`
 * both write a UTF-8 BOM. JSON.parse and @iarna/toml reject it as an unknown
 * character, so a config the CLI itself reads fine used to be reported as
 * unparseable and never got the account key (全面检测 Q41). Writing back
 * without the BOM is harmless: every managed CLI reads plain UTF-8.
 */
function withoutByteOrderMark(content: string): string {
  return content.replace(/^\uFEFF/, '')
}

function requireConfigText(
  filePath: string,
  label: string,
  maximumBytes = MAX_NATIVE_CONFIG_BYTES,
): string | null {
  let info: fs.Stats
  try {
    info = fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink()) {
    throw new Error(`${label} 必须是单链接普通文件，未执行修改`)
  }
  return withoutByteOrderMark(readBoundedUtf8FileSync(filePath, maximumBytes, label))
}

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

/**
 * Gemini CLI runs settings.json and trustedFolders.json through
 * strip-json-comments before JSON.parse, so a file with comments is valid to
 * it and used to be refused here as unparseable -- the account key never got
 * written (全面检测 Q16). Parse them the way Gemini does: comments allowed,
 * trailing commas not (strip-json-comments keeps those and JSON.parse then
 * rejects them). Duplicate keys are refused on this path only, because the
 * comment-preserving write edits one occurrence while Gemini reads the last.
 */
function parseGeminiJsonObject(content: string, label: string, brokenTool?: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    const errors: ParseError[] = []
    const tree = parseTree(content, errors, { allowTrailingComma: false, disallowComments: false })
    // Same reason as requireJson for not surfacing the parser's own message.
    if (!tree || errors.length || hasDuplicateProperties(tree)) {
      throw new Error(brokenTool ? describeBrokenConfig(brokenTool) : `${label} 无法解析为 JSON，未执行修改`)
    }
    parsed = getNodeValue(tree) as unknown
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  throw new Error(brokenTool ? describeBrokenConfig(brokenTool) : `${label} 不是有效的 JSON 对象，未执行修改`)
}

function hasDuplicateProperties(node: Node): boolean {
  if (node.type === 'object') {
    const names = new Set<unknown>()
    for (const property of node.children ?? []) {
      const name = property.children?.[0]?.value as unknown
      if (names.has(name)) return true
      names.add(name)
    }
  }
  return (node.children ?? []).some(hasDuplicateProperties)
}

function readGeminiJson(filePath: string): Record<string, unknown> | null {
  const content = readText(filePath)
  if (!content) return null
  try {
    return parseGeminiJsonObject(withoutByteOrderMark(content), 'Gemini 配置')
  } catch {
    return null
  }
}

function requireGeminiJson(filePath: string, label: string, brokenTool?: string): { parsed: Record<string, unknown>, original: string | null } {
  const original = requireConfigText(filePath, label)
  return { parsed: original === null ? {} : parseGeminiJsonObject(original, label, brokenTool), original }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function collectJsonEdits(
  location: string[],
  before: unknown,
  after: unknown,
  edits: Array<{ path: string[], value: unknown }>,
): void {
  if (isJsonObject(before) && isJsonObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(after, key)) edits.push({ path: [...location, key], value: undefined })
      else if (!Object.hasOwn(before, key)) edits.push({ path: [...location, key], value: after[key] })
      else collectJsonEdits([...location, key], before[key], after[key], edits)
    }
    return
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) edits.push({ path: location, value: after })
}

/**
 * Plain JSON is rewritten as before. A file that only parsed because comments
 * were allowed gets just the changed values edited in place, so the user's
 * comments and layout outside those values survive.
 */
function geminiJsonContent(original: string | null, next: Record<string, unknown>): string {
  if (original === null || !original.trim()) return jsonContent(next)
  try {
    JSON.parse(original)
    return jsonContent(next)
  } catch {
    // Has comments: fall through to the in-place edit.
  }
  const edits: Array<{ path: string[], value: unknown }> = []
  collectJsonEdits([], parseGeminiJsonObject(original, 'Gemini 配置'), next, edits)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let content = original
  for (const edit of edits) {
    content = applyEdits(content, modify(content, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    }))
  }
  return content.endsWith('\n') ? content : `${content}${eol}`
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key]
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>
  }
  const created: Record<string, unknown> = {}
  parent[key] = created
  return created
}

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

/**
 * Gemini CLI 两个开关各管一半：enableAutoUpdate 关掉「启动即静默升级」，
 * enableAutoUpdateNotification 关掉那条英文催更提示。两个默认都是 true。
 */
function disableGeminiSelfUpdate(parsed: Record<string, unknown>): void {
  const general = ensureRecord(parsed, 'general')
  general.enableAutoUpdate = false
  general.enableAutoUpdateNotification = false
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
const MANAGED_GEMINI_SESSION_MAX_AGE = '365d'

/** 只在用户没写过 cleanupPeriodDays 时补上，写过什么值都原样保留。 */
function extendClaudeSessionRetention(parsed: Record<string, unknown>): void {
  if (parsed.cleanupPeriodDays !== undefined) return
  parsed.cleanupPeriodDays = MANAGED_CLAUDE_RETENTION_DAYS
}

/**
 * 只在用户完全没碰过 general.sessionRetention 时补 maxAge。已经有这一段（哪怕只写了
 * enabled: false 或 maxCount）就整段不动：那是用户对保留策略的明确表达，往里塞一个
 * maxAge 会改掉他算好的行为。
 */
function extendGeminiSessionRetention(parsed: Record<string, unknown>): void {
  const general = ensureRecord(parsed, 'general')
  if (general.sessionRetention !== undefined) return
  general.sessionRetention = { maxAge: MANAGED_GEMINI_SESSION_MAX_AGE }
}

// Gemini CLI 的主对话用 GEMINI_MODEL，但一批后台功能各自写死了 Google 官方的型号名：
// 联网搜索、读网页与 codebase_investigator 子代理走 gemini-3-flash-preview，/compress
// 与自动压缩走 gemini-3.1-pro-preview-customtools，每次启动给上次会话写摘要走
// gemini-3.1-flash-lite，Auto 模式先用 flash-lite 分类再用 3.1-pro。中转只开放自己的
// 型号时这些请求一律「无可用渠道」，而 CLI 对它们默默重试：搜索和读网页 2.5 分钟以上
// 才失败，压缩转圈一分多钟，用户只觉得「卡住了」。
//
// modelConfigs.customOverrides 按请求里的型号名改写目标型号，把这批官方名统一指到当前
// 配的中转型号（沙箱实测 0.60.0：上述每一项 2~3 秒完成）。代价是这些后台调用按主型号
// 计费。当前型号本身若恰好在表里，不给它写改写，免得自己指向自己。
//
// 这张表出自 0.60.0 bundle 的 DEFAULT_MODEL_CONFIGS（aliases / modelIdResolutions），
// 升级 Gemini CLI 推荐版本时要重新核一遍。0.61.0 新增 gemini-3.8-flash 与
// gemini-3.5-flash-lite 两个内置型号，/model 菜单里也列着它们，不补上的话用户在菜单里
// 选了就直接发出官方型号名（沙箱实测 0.61.0）。0.62.0 的 DEFAULT_MODEL_CONFIGS 与 0.61.0
// 逐字相同，表不用动。
const geminiRelayHelperModels = [
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'flash-lite',
  'flash',
  'pro',
] as const

function buildGeminiRelayModelOverrides(model: string): Array<Record<string, unknown>> {
  return geminiRelayHelperModels
    .filter((helper) => helper !== model)
    .map((helper) => ({ match: { model: helper }, modelConfig: { model } }))
}

/**
 * 认出本软件写的那种改写：match 只有一个官方型号名、modelConfig 只改 model。用户自己写
 * 的改写（带别的匹配条件或别的参数）不是这个形状，原样保留。
 */
function isGeminiRelayModelOverride(entry: unknown): boolean {
  if (!isJsonRecord(entry) || Object.keys(entry).length !== 2) return false
  const { match, modelConfig } = entry
  if (!isJsonRecord(match) || !isJsonRecord(modelConfig)) return false
  if (Object.keys(match).length !== 1 || Object.keys(modelConfig).length !== 1) return false
  return typeof modelConfig.model === 'string'
    && geminiRelayHelperModels.some((helper) => helper === match.model)
}

function applyGeminiRelayModelOverrides(parsed: Record<string, unknown>, model: string): void {
  const modelConfigs = ensureRecord(parsed, 'modelConfigs')
  const current = modelConfigs.customOverrides
  const kept = Array.isArray(current) ? current.filter((entry) => !isGeminiRelayModelOverride(entry)) : []
  modelConfigs.customOverrides = [...kept, ...buildGeminiRelayModelOverrides(model)]
}

/**
 * 切回 Google 账号时撤掉：官方型号在那边都真实存在，留着改写反而会把后台请求指到一个
 * 官方不存在的中转型号上。只删本软件写的那种，空了连键一起删。
 */
function removeGeminiRelayModelOverrides(parsed: Record<string, unknown>): void {
  const modelConfigs = parsed.modelConfigs
  if (!isJsonRecord(modelConfigs) || !Array.isArray(modelConfigs.customOverrides)) return
  const kept = modelConfigs.customOverrides.filter((entry) => !isGeminiRelayModelOverride(entry))
  if (kept.length === modelConfigs.customOverrides.length) return
  if (kept.length > 0) modelConfigs.customOverrides = kept
  else delete modelConfigs.customOverrides
  if (Object.keys(modelConfigs).length === 0) delete parsed.modelConfigs
}

// Gemini CLI 默认把使用统计发去 play.googleapis.com（clearcut），同时在发给中转的每一个
// 请求上带 x-gemini-api-privileged-user-id: <本机安装 ID>——等于把一个跨会话不变的设备标识
// 交给了中转。国内连不上前者，后者对我们毫无用处。privacy.usageStatisticsEnabled = false
// 两样一起去掉（沙箱实测 0.60.0），不影响任何功能。只在用户没表过态时补，切回 Google 账号
// 时只收回本软件写的那一份。
//
// 「本软件写的」不能凭值猜：用星芒之前自己关掉统计的客户，文件里也是这一个 false，以前切回
// Google 时被一并删掉，统计被悄悄打开（#834 F03）。所以写下它时在 settings.json 旁边记一笔，
// 切回时只认这笔记录。有记录之前写下的那些分不清是谁的，切回时留着：关着统计不影响任何功能。
export const geminiUsageStatisticsRecordName = 'xingmang-gemini-usage-statistics.json'
const geminiUsageStatisticsRecordContent = jsonContent({ version: 1, usageStatisticsEnabled: false })

function disableGeminiRelayUsageStatistics(parsed: Record<string, unknown>): void {
  const privacy = ensureRecord(parsed, 'privacy')
  if (privacy.usageStatisticsEnabled === undefined) privacy.usageStatisticsEnabled = false
}

/** privacy 不是一张表时按没设过算，与 disableGeminiRelayUsageStatistics 的判断一致。 */
function geminiUsageStatisticsSetting(parsed: Record<string, unknown>): unknown {
  return isJsonRecord(parsed.privacy) ? parsed.privacy.usageStatisticsEnabled : undefined
}

function geminiUsageStatisticsRecordPath(roots: ProviderConfigRoots): string {
  return path.join(providerConfigRoot('gemini', roots), geminiUsageStatisticsRecordName)
}

function readGeminiUsageStatisticsRecord(roots: ProviderConfigRoots): string | null {
  const recordPath = geminiUsageStatisticsRecordPath(roots)
  assertSafeConfigPath(recordPath, providerConfigRoot('gemini', roots), 'file')
  return requireConfigText(recordPath, '星芒写过的 Gemini 统计开关记录')
}

/** 记录读不懂就当没有：宁可留着一个关着的统计，也不替客户打开。 */
function geminiUsageStatisticsWrittenByUs(record: string | null): boolean {
  if (!record?.trim()) return false
  try {
    const parsed = JSON.parse(record) as unknown
    return isJsonRecord(parsed) && parsed.version === 1 && parsed.usageStatisticsEnabled === false
  } catch {
    return false
  }
}

/** 写下统计开关时附上这笔记录；已经记着就不重写，免得每次保存多一份 .bak。 */
function geminiUsageStatisticsRecordPlans(roots: ProviderConfigRoots): FilePlan[] {
  if (geminiUsageStatisticsWrittenByUs(readGeminiUsageStatisticsRecord(roots))) return []
  return [{ path: geminiUsageStatisticsRecordPath(roots), content: geminiUsageStatisticsRecordContent }]
}

/** 切回 Google 账号后这笔记录就用完了，写空（同 Claude 旧设置快照，不删文件）。 */
function geminiUsageStatisticsRecordClearPlans(record: string | null, roots: ProviderConfigRoots): FilePlan[] {
  return record?.trim() ? [{ path: geminiUsageStatisticsRecordPath(roots), content: '' }] : []
}

function restoreGeminiUsageStatistics(parsed: Record<string, unknown>, writtenByUs: boolean): void {
  const privacy = parsed.privacy
  if (!writtenByUs || !isJsonRecord(privacy) || privacy.usageStatisticsEnabled !== false) return
  delete privacy.usageStatisticsEnabled
  if (Object.keys(privacy).length === 0) delete parsed.privacy
}

/**
 * 从备份恢复（切换没成功时的回滚、备份页里恢复）只还原 settings.json 和 .env，这笔记录不跟着
 * 回去。恢复出来的 settings.json 里没有那个 false 了，记录就作废：留着的话，客户以后自己关掉
 * 统计，切回 Google 时会被当成星芒写的收回去。返回是否改动了文件。
 */
export function forgetStaleGeminiUsageStatisticsRecord(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('gemini', roots)
  const record = readGeminiUsageStatisticsRecord(roots)
  if (!record?.trim()) return false
  const [settingsPath] = providerConfigPaths('gemini', roots)
  let statistics: unknown
  try {
    assertSafeConfigPath(settingsPath, providerRoot, 'file')
    statistics = geminiUsageStatisticsSetting(requireGeminiJson(settingsPath, '现有 Gemini settings.json').parsed)
  } catch {
    // 读不了就看不出那个 false 还在不在，按不在算：以后少收回一次，不会替客户打开统计。
    statistics = undefined
  }
  if (statistics === false) return false
  executeFilePlans(geminiUsageStatisticsRecordClearPlans(record, roots), {}, providerRoot)
  return true
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
  const line = content.split(/\r?\n/).find((entry) => entry.trimStart().startsWith(`${name}=`))
  if (!line) return ''
  const value = line.slice(line.indexOf('=') + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
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

/**
 * Gemini CLI 0.59 rewrites every model whose name ends in `-flash` to its
 * built-in `gemini-3.5-flash` alias. The relay exposes the current 3.7/3.8
 * tiers with an explicit suffix, bypassing that client-side rewrite. Always
 * report the actual stored ID: a tier suffix must not be hidden in the UI.
 * 0.61.0 stopped that rewrite, but a customer may still be running an older
 * install, so the suffix stays.
 */
export function geminiCliCompatibleModel(model: string): string {
  return /^(gemini-3\.[78]-flash)$/i.test(model.trim()) ? `${model.trim()}-high` : model.trim()
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
  parsed.model = model
  parsed.review_model = model
  parsed.model_provider = providerName
  parsed.check_for_update_on_startup = false
  disableCodexRelayAnalytics(parsed)
  dropDeprecatedCodexConfigKeys(parsed)
  const providerEntry = ensureRecord(ensureRecord(parsed, 'model_providers'), providerName)
  providerEntry.name = typeof providerEntry.name === 'string' && providerEntry.name.trim()
    ? providerEntry.name
    : providerName
  providerEntry.base_url = siteBaseUrl
  // Current Codex accepts only Responses, including for custom model providers.
  // Model names alone cannot establish the relay's protocol compatibility.
  providerEntry.wire_api = 'responses'
  providerEntry.requires_openai_auth = true
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
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(siteBaseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
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
    applyCodexRelayConfig(stored, model, codexRelayProviderFor(stored, siteBaseUrls.codex), siteBaseUrls.codex)
    if (cliHook) applyCodexCliNotify(stored, cliHook)
    if (catalog !== undefined) catalogInUse = applyCodexRelayModelCatalog(stored, templateCatalog)
    nextContent = tomlContent(stored)
  } else if (currentParsed) {
    applyCodexRelayConfig(currentParsed, model, codexRelayProviderFor(currentParsed, siteBaseUrls.codex), siteBaseUrls.codex)
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
  if (mode === 'reset') {
    // Reset only the selected account source. Replacing its snapshot too keeps
    // an old official customization from returning after a relay round trip.
    const initial = 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\ncheck_for_update_on_startup = false\n'
    plans.push({ path: paths.chatgpt, content: initial })
    plans.push({ path: paths.active, content: initial })
    return plans
  }
  if (!currentParsed) return plans
  const storedChatgpt = readStoredCodexConfig(paths.chatgpt, '已保存的 ChatGPT Codex 配置')
  if (storedChatgpt && classifyCodexConfigProfile(TOML.parse(storedChatgpt), siteBaseUrls.codex) === 'official') {
    plans.push({ path: paths.active, content: storedChatgpt })
    return plans
  }
  const cleaned = cloneTomlRecord(currentParsed)
  stripCodexRelayFromConfig(cleaned, siteBaseUrls.codex)
  const cleanContent = tomlContent(cleaned)
  // Older versions could have stored another Xingmang site as the official
  // snapshot. Replace that polluted copy in the same file transaction.
  if (storedChatgpt) plans.push({ path: paths.chatgpt, content: cleanContent })
  plans.push({ path: paths.active, content: cleanContent })
  return plans
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
 * Claude Code 的 /model 菜单与 Default 指向按这份型号清单重写会不会变（见
 * claude-model-picker.ts 的 claudeRelayModelPickerOutdated）。只读，读之前先过路径校验。
 */
export function claudeModelPickerNeedsRefresh(
  availableModels: readonly string[],
  currentModel: string,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('claude', roots)
  const [settingsPath] = providerConfigPaths('claude', roots)
  assertSafeConfigPath(settingsPath, providerRoot, 'file')
  return claudeRelayModelPickerOutdated(requireJson(settingsPath, '现有 Claude settings.json'), availableModels, currentModel)
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
  return {
    baseUrl,
    actualBaseUrl,
    exists: files.some((file) => file.exists),
    hasApiKey: Boolean(apiKey),
    matchesRelay: Boolean(apiKey && actualBaseUrl && relayProviderBaseUrlMatches(provider, actualBaseUrl, baseUrl)),
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
 */
function codexRelayProviderFor(parsed: Record<string, unknown>, siteBaseUrl: string): string {
  const active = typeof parsed.model_provider === 'string' ? parsed.model_provider.trim() : ''
  // Keep a usable active name as is: Codex's resume picker filters sessions by
  // model_provider, so renaming it would hide the customer's earlier chats.
  if (active && !reservedCodexProviders.has(active)) return active
  const providers = isJsonRecord(parsed.model_providers) ? parsed.model_providers : {}
  function isFree(candidate: string): boolean {
    return !Object.prototype.hasOwnProperty.call(providers, candidate)
      || isOwnCodexRelayEntry(providers[candidate], siteBaseUrl)
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
 * error.
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
  if (!isJsonRecord(entry) || !isOwnCodexRelayEntry(entry, siteBaseUrl)) return
  const existing = providers[providerName]
  providers[providerName] = { ...entry, ...(isJsonRecord(existing) ? existing : {}) }
  delete providers[active]
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function tomlContent(value: Record<string, unknown>): string {
  return TOML.stringify(value as Parameters<typeof TOML.stringify>[0])
}

function normalizeWorkspacePathKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const windowsPath = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
  const normalized = windowsPath
    ? trimmed.replace(/\//g, '\\')
    : path.posix.normalize(trimmed.replace(/\\/g, '/'))
  if (windowsPath) {
    const isDriveRoot = /^[A-Za-z]:\\$/.test(normalized)
    return isDriveRoot ? normalized.toLowerCase() : normalized.replace(/[\\]+$/, '').toLowerCase()
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
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

function requireGeminiWorkspaceJson(content: string | null, label: string): Record<string, unknown> {
  return content?.trim() ? parseGeminiJsonObject(content, label) : {}
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

export function trustGeminiWorkspaceInTrustedFoldersText(
  content: string | null,
  workspace: string,
): { content: string; changed: boolean } {
  const trimmedWorkspace = workspace.trim()
  if (!trimmedWorkspace) throw new Error('Gemini CLI 工作目录不能为空')
  const parsed = requireGeminiWorkspaceJson(content, '现有 Gemini CLI trustedFolders.json')
  const existing = matchingWorkspaceKey(parsed, trimmedWorkspace)
  // A folder the user already answered for keeps its answer, including
  // DO_NOT_TRUST. Only a folder Gemini has never asked about gets filled in.
  if (existing !== null) return { content: geminiJsonContent(content, parsed), changed: false }
  parsed[trimmedWorkspace] = 'TRUST_FOLDER'
  return { content: geminiJsonContent(content, parsed), changed: true }
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

export function trustGeminiWorkspace(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  workspace: string,
): WorkspaceTrustWriteResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('gemini', roots)
  const configPath = path.join(providerRoot, 'trustedFolders.json')
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const current = requireConfigText(configPath, '现有 Gemini CLI trustedFolders.json')
  const next = trustGeminiWorkspaceInTrustedFoldersText(current, workspace)
  if (!next.changed) return { backups: [], files: [], changed: false }
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return {
    ...executeFilePlans([{ path: configPath, content: next.content }], {}, providerRoot),
    changed: true,
  }
}

// Gemini CLI 的项目说明文件名由 settings.json 的 context.fileName 决定，默认只有
// "GEMINI.md"。要让它也读共用的 AGENTS.md，就得把这两个名字都放进去。
export const GEMINI_PROJECT_CONTEXT_FILENAMES = ['GEMINI.md', 'AGENTS.md'] as const

export function ensureGeminiContextFilenamesInSettingsText(
  content: string | null,
): { content: string; changed: boolean } {
  const parsed = requireGeminiWorkspaceJson(content, '现有 Gemini CLI settings.json')
  const context = ensureRecord(parsed, 'context')
  const raw = context.fileName
  // 结构读不懂时（既不是字符串也不是数组）一律不动，宁可让 Gemini 自己用默认值，
  // 也不能拿一份看不懂的配置换取读到 AGENTS.md。
  if (raw !== undefined && typeof raw !== 'string' && !Array.isArray(raw)) {
    return { content: geminiJsonContent(content, parsed), changed: false }
  }
  const existing = typeof raw === 'string'
    ? (raw.trim() ? [raw.trim()] : [])
    : Array.isArray(raw) ? raw : []
  const present = new Set(existing.filter((entry): entry is string => typeof entry === 'string'))
  const missing = GEMINI_PROJECT_CONTEXT_FILENAMES.filter((name) => !present.has(name))
  // 已有值一个不删，只把缺的补在后面（含用户自己写的其它文件名），已经齐了就不动。
  if (missing.length === 0) return { content: geminiJsonContent(content, parsed), changed: false }
  context.fileName = [...existing, ...missing]
  return { content: geminiJsonContent(content, parsed), changed: true }
}

/**
 * 让 Gemini CLI 的用户级 settings.json 把 GEMINI.md 与 AGENTS.md 都算作项目说明。
 * 只补不删，已配好就不写。写入走两阶段提交 + .bak + 回滚（I9）。
 */
export function ensureGeminiProjectContextFiles(
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
): WorkspaceTrustWriteResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot('gemini', roots)
  const configPath = path.join(providerRoot, 'settings.json')
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const current = requireConfigText(configPath, '现有 Gemini CLI settings.json')
  const next = ensureGeminiContextFilenamesInSettingsText(current)
  if (!next.changed) return { backups: [], files: [], changed: false }
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return {
    ...executeFilePlans([{ path: configPath, content: next.content }], {}, providerRoot),
    changed: true,
  }
}

// ---------------------------------------------------------------------------
// 星芒画图工具（MCP）
//
// 登录同步后替四家工具登记同一个 xingmang-image。Codex 与 Grok 直接写 config.toml，
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
): boolean {
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const label = provider === 'codex' ? '现有 Codex config.toml' : '现有 Grok config.toml'
  const current = requireConfigText(configPath, label)
  if (current === null) return false
  const parsed = parseTomlForMcp(current, label)
  if (!applyXingmangImageMcpToToml(parsed, invocation, provider)) return false
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

function syncXingmangImageMcpGemini(roots: ProviderConfigRoots, invocation: XingmangImageMcpInvocation): boolean {
  const providerRoot = providerConfigRoot('gemini', roots)
  const configPath = path.join(providerRoot, 'settings.json')
  assertSafeConfigPath(configPath, providerRoot, 'file')
  const label = '现有 Gemini CLI settings.json'
  const current = requireConfigText(configPath, label)
  const parsed = requireGeminiWorkspaceJson(current, label)
  if (!applyXingmangImageMcpToJson(parsed, invocation, 'gemini')) return false
  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  executeFilePlans([{ path: configPath, content: geminiJsonContent(current, parsed) }], {}, providerRoot)
  return true
}

/** 每家单独提交、单独失败：一家的配置读不懂，不该拖累另外三家。 */
export function syncXingmangImageMcpConfigs(
  rootsInput: ProviderConfigRoots,
  invocation: XingmangImageMcpInvocation,
  options: XingmangImageMcpSyncOptions,
): XingmangImageMcpSyncResult {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const changed: ProviderId[] = []
  const warnings: string[] = []
  const steps: Array<[ProviderId, () => boolean]> = [
    ['codex', () => options.codex
      && existingDirectory(roots.codexHome)
      && syncXingmangImageMcpToml('codex', codexConfigSnapshotPaths(roots).active, roots.codexHome, invocation)],
    ['claude', () => existingDirectory(providerConfigRoot('claude', roots))
      && syncXingmangImageMcpClaude(roots, invocation)],
    ['gemini', () => existingDirectory(providerConfigRoot('gemini', roots))
      && syncXingmangImageMcpGemini(roots, invocation)],
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
      if (availableModels) applyClaudeRelayModelPicker(settings, env, availableModels, model)
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
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  const initialPlans = new Map(
    createPlans(provider, apiKey, model, roots, siteBaseUrls, claudeStatusLineCommand, availableModels, cliHook)
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
      denyClaudeRelayTool(ensureRecord(parsed, 'permissions'))
      skipClaudeWebFetchPreflight(parsed)
      ensureClaudeResponseLanguage(parsed)
      extendClaudeSessionRetention(parsed)
      if (claudeStatusLineCommand) applyClaudeStatusLine(parsed, claudeStatusLineCommand)
      if (cliHook) applyClaudeCliHooks(parsed, cliHook)
      if (availableModels) applyClaudeRelayModelPicker(parsed, env, availableModels, model)
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

function backupSuffix(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

type PreparedFilePlan = FilePlan & {
  backupPath: string | null
  existed: boolean
  temporaryPath: string
}

function uniqueBackupPath(filePath: string, suffix: string): string {
  const baseBackupPath = `${filePath}.bak.${suffix}`
  let backupPath = baseBackupPath
  let counter = 1
  while (fs.existsSync(backupPath)) {
    backupPath = `${baseBackupPath}-${counter}`
    counter += 1
  }
  return backupPath
}

const MAX_BACKUPS_PER_FILE = 5

// 备份后缀是时间戳，字典序即时间序；清理失败只静默跳过，绝不影响已成功的保存。
function pruneBackups(
  filePath: string,
  providerRoot: string,
  keep = MAX_BACKUPS_PER_FILE,
): void {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.bak.`
  let entries: string[]
  try {
    assertSafeConfigPath(filePath, providerRoot, 'parent')
    entries = fs.readdirSync(directory)
  } catch {
    return
  }
  const backups = entries.filter((name) => name.startsWith(prefix)).sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    const backupPath = path.join(directory, name)
    try {
      assertSafeConfigPath(backupPath, providerRoot, 'file')
      removeIfPresent(backupPath)
    } catch {
      continue
    }
  }
}

function writeDurableUtf8(filePath: string, content: string, providerRoot: string): void {
  assertSafeConfigPath(filePath, providerRoot, 'file')
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' })
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function assertSafeConfigPath(filePath: string, rootDirectory: string, target: 'file' | 'parent'): void {
  // A profile moved to another disk is judged at where it lives now; any link the
  // relocation policy does not accept stays in the path and is rejected below.
  const root = resolveRelocatedPath(rootDirectory)
  const resolved = resolveRelocatedPath(filePath)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`配置路径越过 Provider 根目录，已拒绝写入：${filePath}`)
  }

  assertNoReparseComponents(root, 'Provider 配置根目录')
  const stopAt = target === 'parent' ? path.dirname(resolved) : resolved
  assertNoReparseComponents(stopAt, '配置路径')

  let canonicalRoot: string | null = null
  try {
    const rootInfo = fs.lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`配置根目录不是安全的本地目录：${root}`)
    }
    canonicalRoot = fs.realpathSync.native(root)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('配置根目录')) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法验证配置根目录：${root}`)
    }
  }

  const segments = path.relative(root, stopAt).split(path.sep).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    let info: fs.Stats
    try {
      info = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`配置路径包含符号链接，已拒绝写入：${current}`)
    if (target === 'parent' || current !== resolved) {
      if (!info.isDirectory()) throw new Error(`配置父路径不是目录，已拒绝写入：${current}`)
    } else if (!info.isFile() || info.nlink > 1) {
      throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${current}`)
    }
    if (canonicalRoot) {
      const canonical = fs.realpathSync.native(current)
      const canonicalRelative = path.relative(canonicalRoot, canonical)
      if (
        canonicalRelative.startsWith(`..${path.sep}`)
        || canonicalRelative === '..'
        || path.isAbsolute(canonicalRelative)
      ) {
        throw new Error(`配置路径指向 Provider 根目录之外，已拒绝写入：${current}`)
      }
    }
  }

  if (target === 'file') {
    try {
      const info = fs.lstatSync(resolved)
      if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) {
        throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${resolved}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function assertSafeExistingFile(filePath: string, providerRoot: string): void {
  assertSafeConfigPath(filePath, providerRoot, 'file')
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) {
      throw new Error(`配置事务源不是单链接普通文件，已拒绝写入：${filePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`配置事务源文件不存在，已拒绝写入：${filePath}`)
    }
    throw error
  }
}

function assertSafeSourceAndTarget(
  sourcePath: string,
  targetPath: string,
  providerRoot: string,
): void {
  assertSafeExistingFile(sourcePath, providerRoot)
  assertSafeConfigPath(targetPath, providerRoot, 'file')
}

function prepareFilePlans(plans: FilePlan[], providerRoot: string): PreparedFilePlan[] {
  const seenTargets = new Set<string>()
  const suffix = backupSuffix()
  return plans.map((plan) => {
    const targetKey = path.resolve(plan.path).toLowerCase()
    if (seenTargets.has(targetKey)) throw new Error(`配置写入计划包含重复路径：${plan.path}`)
    seenTargets.add(targetKey)
    assertSafeConfigPath(plan.path, providerRoot, 'parent')
    let existed = false
    try {
      const info = fs.lstatSync(plan.path)
      if (!info.isFile() || info.nlink > 1 || info.isSymbolicLink()) {
        throw new Error(`配置目标不是单链接普通文件，已拒绝写入：${plan.path}`)
      }
      existed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      ...plan,
      existed,
      backupPath: existed ? uniqueBackupPath(plan.path, suffix) : null,
      temporaryPath: `${plan.path}.xingmang-${randomUUID()}.tmp`,
    }
  }).filter((plan) => plan.existed || !isRemovePlan(plan))
}

function rollbackCommittedPlans(
  committed: PreparedFilePlan[],
  providerRoot: string,
): Error[] {
  const rollbackErrors: Error[] = []
  for (const plan of [...committed].reverse()) {
    if (plan.existed && plan.backupPath) {
      const rollbackPath = `${plan.path}.xingmang-rollback-${randomUUID()}.tmp`
      let rollbackCopyCreated = false
      try {
        assertSafeSourceAndTarget(plan.backupPath, rollbackPath, providerRoot)
        fs.copyFileSync(plan.backupPath, rollbackPath, fs.constants.COPYFILE_EXCL)
        rollbackCopyCreated = true
        renameWithTransientRetrySync(
          rollbackPath,
          plan.path,
          () => assertSafeSourceAndTarget(rollbackPath, plan.path, providerRoot),
        )
        rollbackCopyCreated = false
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
      if (rollbackCopyCreated) {
        try {
          assertSafeConfigPath(rollbackPath, providerRoot, 'file')
          removeIfPresent(rollbackPath)
        } catch (error) {
          rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
        }
      }
    } else {
      try {
        assertSafeConfigPath(plan.path, providerRoot, 'file')
        removeIfPresent(plan.path)
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
  return rollbackErrors
}

function cleanupPreparedPlans(
  prepared: PreparedFilePlan[],
  providerRoot: string,
): Error[] {
  const cleanupErrors: Error[] = []
  for (const plan of prepared) {
    try {
      assertSafeConfigPath(plan.temporaryPath, providerRoot, 'file')
      removeIfPresent(plan.temporaryPath)
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return cleanupErrors
}

export function executeFilePlans(
  plans: FilePlan[],
  hooks: NativeConfigWriteHooks,
  providerRoot: string,
): NativeConfigSaveResult {
  const prepared = prepareFilePlans(plans, providerRoot)
  const committed: PreparedFilePlan[] = []

  try {
    // No target is touched until every new file has been written successfully.
    for (const plan of prepared) {
      if (isRemovePlan(plan)) continue
      assertSafeConfigPath(plan.path, providerRoot, 'parent')
      fs.mkdirSync(path.dirname(plan.path), { recursive: true })
      writeDurableUtf8(plan.temporaryPath, plan.content, providerRoot)
    }
    for (const plan of prepared) {
      if (plan.backupPath) {
        assertSafeSourceAndTarget(plan.path, plan.backupPath, providerRoot)
        fs.copyFileSync(plan.path, plan.backupPath, fs.constants.COPYFILE_EXCL)
      }
    }
    for (const [index, plan] of prepared.entries()) {
      // Removal moves the file aside instead of deleting it, so the rollback
      // below can still put the .bak copy back; the cleanup after a full commit
      // deletes the moved-aside file together with the other temporaries.
      const [source, target] = isRemovePlan(plan) ? [plan.path, plan.temporaryPath] : [plan.temporaryPath, plan.path]
      assertSafeSourceAndTarget(source, target, providerRoot)
      // A hook may re-read what this save was computed from (external-tool-config
      // does), so it runs again before every retry: whoever held the file may
      // have just saved its own change.
      renameWithTransientRetrySync(source, target, () => {
        hooks.beforeReplace?.(plan.path, index)
        assertSafeSourceAndTarget(source, target, providerRoot)
      })
      committed.push(plan)
    }
  } catch (error) {
    const recoveryErrors = [
      ...rollbackCommittedPlans(committed, providerRoot),
      ...cleanupPreparedPlans(prepared, providerRoot),
    ]
    if (recoveryErrors.length) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        '配置写入失败，且部分文件无法自动回滚；请从 .bak 备份恢复',
      )
    }
    throw error
  }

  const cleanupErrors = cleanupPreparedPlans(prepared, providerRoot)
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, '配置已写入，但临时文件无法安全清理')
  }

  // 必须在全部提交成功后清理：回滚依赖本次 backupPath，提前删除会破坏恢复链路。
  for (const plan of prepared) pruneBackups(plan.path, providerRoot)

  return {
    backups: prepared.flatMap((plan) => plan.backupPath ? [plan.backupPath] : []),
    files: prepared.map((plan) => plan.path),
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
  const plans = mode === 'merge'
    ? createMergePlans(provider, apiKey, model, roots, siteBaseUrlsInput, statusLineCommand, availableModels, cliHook, codexModelCatalog)
    : createPlans(provider, apiKey, model, roots, siteBaseUrlsInput, statusLineCommand, availableModels, cliHook, codexModelCatalog)

  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}

// 模板改进只在「保存配置」那几条路上落盘，而老客户开机走的是恢复账号、一个字不写，
// 于是 0.2.7 之后加进模板的那些项（Codex 关统计、Windows 沙箱不弹管理员框、Claude Code
// 读网页不问官方、Gemini 不自己升级、Grok 出图走当前账号……）他们一项都没拿到。
//
// 这个号记在工具配置来源记录里（tool-config-ownership.ts）：记录落后于它、来源又确认是
// 当前账号的配置，开机时由 fillRelayTemplateDefaults 补一次缺省项。往下面那几个
// fill*RelayTemplateDefaults 里加了新的一项，就把这个号加一，否则老客户拿不到。
export const relayTemplateRevision = 1

/** 键缺省时建一张表；已经是表就用它；是别的东西（用户写坏了或另有用途）返回 null，一字不动。 */
function fillableRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (parent[key] === undefined) parent[key] = {}
  const current = parent[key]
  return isJsonRecord(current) ? current : null
}

function fillCodexRelayTemplateDefaults(parsed: Record<string, unknown>, platform: NodeJS.Platform): void {
  if (parsed.check_for_update_on_startup === undefined) parsed.check_for_update_on_startup = false
  if (parsed.approval_policy === undefined) parsed.approval_policy = 'on-request'
  if (parsed.sandbox_mode === undefined) parsed.sandbox_mode = 'workspace-write'
  if (parsed.analytics === undefined || isJsonRecord(parsed.analytics)) disableCodexRelayAnalytics(parsed)
  dropDeprecatedCodexConfigKeys(parsed)
  applyCodexRelayMachineDefaults(parsed, platform)
}

function fillClaudeRelayTemplateDefaults(parsed: Record<string, unknown>): void {
  const env = fillableRecord(parsed, 'env')
  if (env && env.DISABLE_AUTOUPDATER === undefined) disableClaudeSelfUpdate(env)
  const permissions = fillableRecord(parsed, 'permissions')
  if (permissions && (permissions.deny === undefined || Array.isArray(permissions.deny))) denyClaudeRelayTool(permissions)
  if (parsed.skipWebFetchPreflight === undefined) skipClaudeWebFetchPreflight(parsed)
  ensureClaudeResponseLanguage(parsed)
  extendClaudeSessionRetention(parsed)
}

function fillGeminiRelayTemplateDefaults(parsed: Record<string, unknown>, model: string): void {
  const general = fillableRecord(parsed, 'general')
  if (general) {
    if (general.enableAutoUpdate === undefined) general.enableAutoUpdate = false
    if (general.enableAutoUpdateNotification === undefined) general.enableAutoUpdateNotification = false
    extendGeminiSessionRetention(parsed)
  }
  if (parsed.privacy === undefined || isJsonRecord(parsed.privacy)) disableGeminiRelayUsageStatistics(parsed)
  // 已经有本软件写的那种改写就整段不动：那一组按写入时的型号生成，型号和名单都由保存配置
  // 那条路负责刷新，这里只给从来没有过这一段的老配置补上。
  const modelConfigs = parsed.modelConfigs
  if (!model || (modelConfigs !== undefined && !isJsonRecord(modelConfigs))) return
  const overrides = isJsonRecord(modelConfigs) ? modelConfigs.customOverrides : undefined
  if (overrides !== undefined && !Array.isArray(overrides)) return
  if (Array.isArray(overrides) && overrides.some(isGeminiRelayModelOverride)) return
  applyGeminiRelayModelOverrides(parsed, model)
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
      fillCodexRelayTemplateDefaults(parsed, platform)
      dropEmptyCreatedTables(parsed, before)
      if (JSON.stringify(parsed) === JSON.stringify(before)) return []
      const content = tomlContent(parsed)
      return [{ path: snapshots.relay, content }, { path: snapshots.active, content }]
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
      if (JSON.stringify(parsed) === JSON.stringify(before)) return []
      return [{ path: paths[0], content: tomlContent(parsed) }]
    }
  }
}

/** 这份配置还缺不缺模板里的项。只读；不是指向当前账号服务的配置一律算「不缺」。 */
export function relayTemplateDefaultsPending(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots,
  siteBaseUrlsInput: Record<ProviderId, string>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  for (const filePath of providerConfigPaths(provider, roots)) assertSafeConfigPath(filePath, providerRoot, 'file')
  return relayTemplateDefaultsPlans(provider, roots, siteBaseUrlsInput, platform).length > 0
}

/**
 * 给一份「当前账号的」配置只补模板里缺的那几项：键缺省才写，用户写过的值（哪怕写的是
 * false）一律不动，Key、服务地址、型号、钩子、状态行这些也都不碰。配置不是指向当前
 * 账号服务的（切回了官方、换了别家）就什么都不做。写入与保存配置同一套两阶段提交、
 * 留 .bak、失败回滚（I9）。返回 null = 这份配置已经齐了，没写任何文件。
 */
export function fillRelayTemplateDefaults(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots,
  siteBaseUrlsInput: Record<ProviderId, string>,
  hooks: NativeConfigWriteHooks = {},
  platform: NodeJS.Platform = process.platform,
): NativeConfigSaveResult | null {
  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  for (const filePath of providerConfigPaths(provider, roots)) assertSafeConfigPath(filePath, providerRoot, 'file')
  const plans = relayTemplateDefaultsPlans(provider, roots, siteBaseUrlsInput, platform)
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
 * 从星芒打开 Claude Code 时也不交给它（system-service.ts 的 launchExcludedEnvironmentVariables，已知45 跟进），
 * 范围靠这一处和这里挪开的对齐。ANTHROPIC_API_KEY 不在内：Windows、Linux 上它由检查页提示，Mac 的启动
 * 脚本另外去掉（macosShellOverrideVariables）。
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
