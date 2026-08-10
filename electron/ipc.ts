import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron'
import type { AppSettings, AppTheme } from './app-settings'
import type { ConfigBackupStore } from './backups'
import { cliCatalog, isProviderId } from './catalog'
import { relaySites } from './relay-sites'
import type {
  AddMarketplaceInput,
  AddMcpInput,
  CodexExtensionService,
  ImportSkillInput,
} from './codex-extensions'
import {
  ProviderExtensionService,
  type ProviderExtensionMutation,
  type ProviderExtensionsSnapshot,
} from './provider-extensions'
import {
  type CodexSessionListQuery,
  CodexSessionsService,
} from './codex-sessions'
import {
  ProviderSessionsService,
  providerSessionProviders,
  type ProviderSessionListQuery,
} from './provider-sessions'
import type { NativeConfigSaveMode } from './config-files'
import {
  isAllowedExternalUrl,
  isTrustedIpcSenderUrl,
  type ApplicationUrlPolicy,
} from './security'
import type {
  CodexDesktopLaunchMode,
  ConfigSavePayload,
  SystemSnapshot,
  SystemService,
} from './system-service'
import { ensureSafeDataDirectory, writeAtomicSafeUtf8File } from './safe-local-data'
import type { UpdateSnapshot, UpdaterService } from './updater'
import {
  createNewApiClient,
  type NewApiAccountKeysQuery,
  type NewApiAccountUsageQuery,
  type NewApiChangePasswordInput,
  type NewApiLoginInput,
  type NewApiRegisterInput,
  type NewApiResetPasswordInput,
} from './new-api-client'
import type { RelayBackendClient } from './relay-backend'
import type { DiagnosticsReport } from './diagnostics'
import type { RuntimeLogStore } from './runtime-log'
import { createExternalShellLauncher, type ExternalShellLauncher } from './system-shell'
import { platformCapabilitiesFor } from './platform-capabilities'

export type AppWindowMode = 'onboarding' | 'dashboard'

export interface IpcRegistrationOptions {
  systemService: SystemService
  sessionsService: CodexSessionsService
  providerSessionsService: ProviderSessionsService
  backupStore: ConfigBackupStore
  diagnosticsService: {
    run(): Promise<DiagnosticsReport>
    exportLatest(): string
  }
  runtimeLog: RuntimeLogStore
  extensionService: CodexExtensionService
  providerExtensionService: ProviderExtensionService
  // Defaults to a real client talking to the production New-Api instance
  // when the host app does not supply one; tests inject a stub the same way
  // they do for other services. Typed as the backend-agnostic
  // RelayBackendClient (relay-backend.ts), not new-api-client.ts's concrete
  // type -- this module never needs to know which relay backend is active.
  accountService?: RelayBackendClient
  // Resolves once main.ts's startup session-restore attempt (see
  // account-session-store.ts's restoreAccountSessionOnStartup) has settled,
  // success or failure -- awaited by account:get-session so the renderer's
  // very first query on mount never races the async refresh-then-self round
  // trip restoreSession() performs (docs/RECON-new-api.md section D). Never
  // rejects by contract; defaults to an already-resolved promise so tests and
  // any host that never attempts a restore see the pre-existing synchronous
  // behavior unchanged.
  accountSessionReady?: Promise<void>
  urlPolicy: ApplicationUrlPolicy
  previewOnboarding: boolean
  externalUrlAllowlist: readonly string[]
  externalShell?: ExternalShellLauncher
  updaterService: UpdaterService
  broadcastUpdate(snapshot: UpdateSnapshot): void
  setWindowMode(target: WebContents, mode: AppWindowMode): void
  setWindowTheme(target: WebContents, theme: AppTheme): void
  // Opens (or focuses, if already open) the isolated canvas window. Kept as
  // a plain callback -- not a CanvasWindowController -- so this module never
  // has to depend on canvas-window.ts's full surface just to delegate one
  // button click.
  openCanvasWindow(): Promise<void>
  transformSystemSnapshot?: (snapshot: SystemSnapshot) => SystemSnapshot
}

type TrustedIpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label}格式错误`)
  }
  return value.trim()
}

function optionalString(value: unknown, label: string, maximum = 4_096): string | undefined {
  if (value === undefined || value === '') return undefined
  return requiredString(value, label, maximum)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label}格式错误`)
  return value
}

function stringArray(value: unknown, label: string, maximumItems = 128): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label}格式错误`)
  return value.map((entry) => requiredString(entry, label))
}

function parseSettings(value: unknown): AppSettings {
  if (!isRecord(value) || value.version !== 2) throw new Error('设置格式错误')
  if (value.theme !== 'light' && value.theme !== 'dark') throw new Error('主题格式错误')
  for (const key of ['checkUpdatesOnStartup', 'runDiagnosticsOnStartup'] as const) {
    if (typeof value[key] !== 'boolean') throw new Error('设置格式错误')
  }
  const sidebarMoreExpanded = optionalBoolean(value.sidebarMoreExpanded, '侧边栏展开状态')
  // Same degrade-don't-throw semantics as app-settings.ts's parseRelaySiteId:
  // an unknown/stale site id must never brick saving the rest of the
  // settings, so it is dropped here (and would be dropped again by
  // app-settings.ts's own validation at persist time -- this hop is the
  // defense-in-depth I5 copy, not the only line). Without this passthrough
  // the renderer's settings:save round trip silently reset the site choice
  // to the default on every save.
  const relaySiteId = typeof value.relaySiteId === 'string'
    && relaySites.some((site) => site.id === value.relaySiteId)
    ? value.relaySiteId
    : undefined
  // Same degrade-don't-throw passthrough as relaySiteId above: dropping an
  // unknown policy string must never brick saving the rest of the settings,
  // and app-settings.ts re-validates at persist time (defense-in-depth I5).
  const mirrorPolicy = value.mirrorPolicy === 'mirror-first' || value.mirrorPolicy === 'official-first'
    ? value.mirrorPolicy
    : undefined
  return {
    version: 2,
    workspace: requiredString(value.workspace, '工作目录', 32_767),
    theme: value.theme,
    checkUpdatesOnStartup: value.checkUpdatesOnStartup === true,
    runDiagnosticsOnStartup: value.runDiagnosticsOnStartup === true,
    ...(sidebarMoreExpanded === true ? { sidebarMoreExpanded: true as const } : {}),
    ...(relaySiteId !== undefined ? { relaySiteId } : {}),
    ...(mirrorPolicy !== undefined ? { mirrorPolicy } : {}),
  }
}

function parseMcpInput(value: unknown): AddMcpInput {
  if (!isRecord(value)) throw new Error('MCP 配置格式错误')
  const name = requiredString(value.name, 'MCP 名称', 128)
  if (value.type === 'stdio') {
    const envValue = value.env
    if (envValue !== undefined && !isRecord(envValue)) throw new Error('MCP 环境变量格式错误')
    const envEntries = Object.entries(envValue ?? {})
    if (envEntries.length > 128) throw new Error('MCP 环境变量数量过多')
    const env: Record<string, string> = {}
    for (const [key, entry] of envEntries) {
      if (typeof entry !== 'string' || entry.length > 4_096) throw new Error('MCP 环境变量格式错误')
      env[requiredString(key, '环境变量名', 128)] = entry
    }
    return {
      type: 'stdio',
      name,
      command: requiredString(value.command, 'MCP 命令'),
      args: stringArray(value.args, 'MCP 参数'),
      env,
    }
  }
  if (value.type !== 'http') throw new Error('MCP 类型错误')
  return {
    type: 'http',
    name,
    url: requiredString(value.url, 'MCP 地址'),
    bearerTokenEnvVar: optionalString(value.bearerTokenEnvVar, 'Bearer Token 环境变量名', 128),
    oauthClientId: optionalString(value.oauthClientId, 'OAuth Client ID'),
    oauthResource: optionalString(value.oauthResource, 'OAuth Resource'),
  }
}

function parseMarketplaceInput(value: unknown): AddMarketplaceInput {
  if (!isRecord(value)) throw new Error('市场配置格式错误')
  return {
    source: requiredString(value.source, '市场来源'),
    ref: optionalString(value.ref, 'Git Ref', 256),
    sparse: stringArray(value.sparse, 'Sparse 路径'),
  }
}

function parseSkillInput(value: unknown): ImportSkillInput {
  if (!isRecord(value)) throw new Error('Skill 导入格式错误')
  if (value.scope !== undefined && value.scope !== 'user' && value.scope !== 'repo') {
    throw new Error('Skill 范围格式错误')
  }
  return {
    sourcePath: requiredString(value.sourcePath, 'Skill 路径', 32_767),
    scope: value.scope,
  }
}

function parseProviderExtensionMutation(value: unknown): ProviderExtensionMutation {
  if (!isRecord(value) || !isProviderId(value.provider)) {
    throw new Error('扩展操作格式错误')
  }
  const kind = String(value.kind)
  if (!['mcp', 'skill', 'plugin'].includes(kind)) {
    throw new Error('扩展类型错误')
  }
  const action = String(value.action)
  if (!['install', 'uninstall', 'enable', 'disable', 'update'].includes(action)) {
    throw new Error('扩展操作类型错误')
  }
  const scope = value.scope === undefined ? undefined : String(value.scope)
  if (scope !== undefined && !['user', 'project', 'local', 'workspace'].includes(scope)) {
    throw new Error('扩展范围错误')
  }

  let mcp: ProviderExtensionMutation['mcp']
  if (value.mcp !== undefined) {
    if (!isRecord(value.mcp)) throw new Error('MCP 安装配置格式错误')
    if (value.mcp.type === 'http') {
      mcp = {
        type: 'http',
        url: requiredString(value.mcp.url, 'MCP 地址'),
      }
    } else if (value.mcp.type === 'stdio') {
      const envValue = value.mcp.env
      if (envValue !== undefined && !isRecord(envValue)) throw new Error('MCP 环境变量格式错误')
      const envEntries = Object.entries(envValue ?? {})
      if (envEntries.length > 128) throw new Error('MCP 环境变量数量过多')
      const env: Record<string, string> = {}
      for (const [key, entry] of envEntries) {
        if (typeof entry !== 'string' || entry.length > 4_096) throw new Error('MCP 环境变量格式错误')
        env[requiredString(key, '环境变量名', 128)] = entry
      }
      mcp = {
        type: 'stdio',
        command: requiredString(value.mcp.command, 'MCP 命令'),
        args: stringArray(value.mcp.args, 'MCP 参数'),
        env,
      }
    } else {
      throw new Error('MCP 安装配置类型错误')
    }
  }

  return {
    provider: value.provider,
    kind: kind as ProviderExtensionMutation['kind'],
    action: action as ProviderExtensionMutation['action'],
    id: optionalString(value.id, '扩展 ID', 512),
    source: optionalString(value.source, '扩展来源'),
    scope: scope as ProviderExtensionMutation['scope'],
    mcp,
  }
}

function parseConfigSavePayload(payload: unknown): ConfigSavePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('配置请求格式错误')
  }
  const input = payload as {
    provider?: unknown
    apiKey?: unknown
    model?: unknown
    mode?: unknown
  }
  if (!isProviderId(input.provider)) throw new Error('未知的 CLI 类型')
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 4_096) {
    throw new Error('API Key 格式错误')
  }
  if (typeof input.model !== 'string' || input.model.length > 256) {
    throw new Error('模型格式错误')
  }
  if (input.mode !== 'merge' && input.mode !== 'reset') {
    throw new Error('配置保存方式错误')
  }
  return {
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    mode: input.mode as NativeConfigSaveMode,
  }
}

function parseWorkspace(workspace: unknown, fallback: string): string {
  if (typeof workspace === 'string' && workspace.length > 32_767) {
    throw new Error('工作目录格式错误')
  }
  return typeof workspace === 'string' && workspace.trim() ? workspace.trim() : fallback
}

function parseDesktopLaunchMode(mode: unknown): CodexDesktopLaunchMode {
  if (mode !== 'open' && mode !== 'restart') throw new Error('Codex 桌面端启动方式错误')
  return mode
}

function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error('会话 ID 格式错误')
  }
  return value
}

function parseSessionListQuery(value: unknown): CodexSessionListQuery {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('会话查询格式错误')
  }
  const input = value as Record<string, unknown>
  const archive = input.archive
  if (archive !== undefined && archive !== 'all' && archive !== 'active' && archive !== 'archived') {
    throw new Error('会话归档筛选格式错误')
  }
  if (input.search !== undefined) {
    if (typeof input.search !== 'string') throw new Error('会话搜索内容格式错误')
    if (input.search.length > 256) throw new Error('会话搜索内容过长')
  }
  const integer = (entry: unknown, label: string) => {
    if (entry === undefined) return undefined
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
      throw new Error(`${label}格式错误`)
    }
    return entry
  }
  return {
    search: typeof input.search === 'string' ? input.search : undefined,
    archive,
    page: integer(input.page, '页码'),
    pageSize: integer(input.pageSize, '分页大小'),
  }
}

function parseProviderSessionListQuery(value: unknown): ProviderSessionListQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('会话查询格式错误')
  const provider = value.provider
  if (
    provider !== undefined
    && provider !== 'all'
    && !providerSessionProviders.includes(provider as (typeof providerSessionProviders)[number])
  ) {
    throw new Error('会话工具类型错误')
  }
  if (value.search !== undefined) {
    if (typeof value.search !== 'string') throw new Error('会话搜索内容格式错误')
    if (value.search.length > 256) throw new Error('会话搜索内容过长')
  }
  const integer = (entry: unknown, label: string) => {
    if (entry === undefined) return undefined
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
      throw new Error(`${label}格式错误`)
    }
    return entry
  }
  return {
    provider: provider as ProviderSessionListQuery['provider'],
    search: typeof value.search === 'string' ? value.search : undefined,
    page: integer(value.page, '页码'),
    pageSize: integer(value.pageSize, '分页大小'),
  }
}

function parseRendererError(value: unknown): { message: string; stack?: string; context?: string } {
  if (!isRecord(value)) throw new Error('渲染进程错误格式无效')
  return {
    message: requiredString(value.message, '错误消息', 4_096),
    stack: optionalString(value.stack, '错误堆栈', 16_384),
    context: optionalString(value.context, '错误上下文', 256),
  }
}

function parseAccountLoginInput(value: unknown): NewApiLoginInput {
  if (!isRecord(value)) throw new Error('登录信息格式错误')
  const username = requiredString(value.username, '用户名或邮箱', 128)
  // Not requiredString: a password must be forwarded exactly as typed, and
  // requiredString() both trims it and rejects an all-whitespace value.
  if (typeof value.password !== 'string' || !value.password || value.password.length > 256) {
    throw new Error('密码格式错误')
  }
  return {
    username,
    password: value.password,
    turnstileToken: optionalString(value.turnstileToken, '人机验证 Token', 4_096),
  }
}

// Deliberately permissive (not full RFC 5322): catches the typos users
// actually make without rejecting a valid-but-unusual address. Mirrors
// src/components/account/validation.ts's EMAIL_PATTERN, kept as a separate
// literal rather than a shared import -- electron/ never imports from src/
// (renderer code may depend on Node-free bundling; see CLAUDE.md I6/I7) --
// and this is the one account:* input parser that actually needs a format
// check rather than requiredString()'s bare non-empty test, since a
// malformed address here would silently fail server-side with no useful
// per-field feedback back to RegisterDialog.
const accountEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseAccountEmailInput(value: unknown): string {
  const email = requiredString(value, '邮箱地址', 254)
  if (!accountEmailPattern.test(email)) throw new Error('请输入正确的邮箱地址')
  return email
}

function parseAccountRegisterInput(value: unknown): NewApiRegisterInput {
  if (!isRecord(value)) throw new Error('注册信息格式错误')
  const email = requiredString(value.email, '邮箱地址', 254)
  // Required, not defaulted from email: new-api enforces uniqueness on
  // username independently of email (see NewApiRegisterInput's own comment
  // in new-api-client.ts), and RegisterDialog.tsx now collects a real
  // username field for the caller to send here.
  const username = requiredString(value.username, '用户名', 128)
  // Not requiredString: see parseAccountLoginInput above for why passwords
  // are forwarded exactly as typed rather than trimmed.
  if (typeof value.password !== 'string' || !value.password || value.password.length > 256) {
    throw new Error('密码格式错误')
  }
  const verificationCode = requiredString(value.verificationCode, '邮箱验证码', 32)
  return {
    email,
    password: value.password,
    verificationCode,
    username,
    affCode: optionalString(value.affCode, '邀请码', 64),
  }
}

// account:reset-password's input. token is the opaque value copied out of
// the emailed reset link's `token=` query parameter (see
// NewApiResetPasswordInput's own comment in new-api-client.ts) -- bounded
// generously (256 chars) rather than pinned to the 32-hex-char shape
// new-api currently generates it as, so a future change to that length on
// the server side degrades to "wrong code" instead of "rejected before it
// even reaches the server".
function parseAccountPasswordResetInput(value: unknown): NewApiResetPasswordInput {
  if (!isRecord(value)) throw new Error('重置密码信息格式错误')
  return {
    email: parseAccountEmailInput(value.email),
    token: requiredString(value.token, '重置码', 256),
  }
}

// account:get-usage's input. Both fields optional (omitted -> new-api's own
// server-side defaults, common/page_info.go's GetPageQuery: page 1, page size
// 10). pageSize is capped at 100 to match that same function's own clamp --
// rejecting an oversized value here up front rather than letting the server
// silently truncate it avoids a caller thinking it asked for more rows than
// it actually got back. page's upper bound is a generous sanity ceiling, not
// a real limit tied to anything server-side.
function parseAccountUsageQuery(value: unknown): NewApiAccountUsageQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('用量查询参数格式错误')
  const page = value.page
  if (page !== undefined && (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 1_000_000)) {
    throw new Error('页码格式错误')
  }
  const pageSize = value.pageSize
  if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new Error('分页大小格式错误')
  }
  return {
    page: page as number | undefined,
    pageSize: pageSize as number | undefined,
  }
}

// account:list-keys' input. Same GetPageQuery-backed pagination family and
// the same bounds as parseAccountUsageQuery above (common/page_info.go's
// clamp to 100 regardless of what is sent).
function parseAccountKeysQuery(value: unknown): NewApiAccountKeysQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('Key 查询参数格式错误')
  const page = value.page
  if (page !== undefined && (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 1_000_000)) {
    throw new Error('页码格式错误')
  }
  const pageSize = value.pageSize
  if (pageSize !== undefined && (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new Error('分页大小格式错误')
  }
  return {
    page: page as number | undefined,
    pageSize: pageSize as number | undefined,
  }
}

// account:revoke-key's sole argument. A destructive, id-addressed operation
// that lands directly in a URL path segment (new-api-client.ts's
// tokenIdPath) -- must be a genuine positive integer before it gets
// anywhere near that, same "reject anything that isn't obviously a real id"
// posture as parseSessionId's UUID regex above (I5, path-traversal-shaped
// defense even though the value here is numeric, not a path string).
function parseAccountRevokeKeyId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('Key ID 格式错误')
  }
  return value
}

// account:change-password's input. MIN/MAX mirror
// src/components/account/validation.ts's own MIN_PASSWORD_LENGTH /
// MAX_PASSWORD_LENGTH (confirmed against QuantumNous/new-api's model.User
// struct tag validate:"min=8,max=20") -- kept as separate literals rather
// than a shared import, same reasoning as accountEmailPattern above:
// electron/ never imports from src/ (CLAUDE.md I6/I7). originalPassword is
// only checked for presence (not length-bounded): the server is the actual
// authority on whether it matches the account's current password, and
// rejecting it here on a length technicality before the server even gets to
// say "wrong password" would be a worse failure mode. Neither field is
// trimmed -- both must be forwarded exactly as typed, same as
// parseAccountLoginInput's password field.
const MIN_ACCOUNT_PASSWORD_LENGTH = 8
const MAX_ACCOUNT_PASSWORD_LENGTH = 20

function parseAccountChangePasswordInput(value: unknown): NewApiChangePasswordInput {
  if (!isRecord(value)) throw new Error('修改密码信息格式错误')
  if (
    typeof value.originalPassword !== 'string'
    || !value.originalPassword
    || value.originalPassword.length > 256
  ) {
    throw new Error('原密码格式错误')
  }
  const newPassword = value.newPassword
  if (
    typeof newPassword !== 'string'
    || newPassword.length < MIN_ACCOUNT_PASSWORD_LENGTH
    || newPassword.length > MAX_ACCOUNT_PASSWORD_LENGTH
  ) {
    throw new Error(`新密码长度需为 ${MIN_ACCOUNT_PASSWORD_LENGTH} 到 ${MAX_ACCOUNT_PASSWORD_LENGTH} 位`)
  }
  return { originalPassword: value.originalPassword, newPassword }
}

const ipcOperationLabels: Readonly<Record<string, string>> = {
  'system:scan': '本机环境与 AI 工具检测',
  'startup:codex-readiness': 'Codex 启动状态检测',
  'config:get': '工具配置读取',
  'config:reveal-api-key': 'API Key 明文读取',
  'config:save': '工具配置保存',
  'workspace:choose': '工作目录选择',
  'repository:get-context': '仓库上下文读取',
  'runtime:install-node': 'Node.js LTS 自动安装',
  'cli:install': 'CLI 安装或更新',
  'cli:uninstall': 'CLI 卸载',
  'cli:check-update': 'CLI 单项更新检查',
  'setup:codex-status': 'Codex 初始化状态检测',
  'desktop:install-codex': 'Codex 桌面端安装',
  'desktop:uninstall-codex': 'Codex 桌面端卸载',
  'desktop:check-update-codex': 'Codex 桌面端更新检查',
  'cli:launch': 'CLI 终端启动',
  'desktop:codex-status': 'Codex 桌面端运行状态检测',
  'desktop:launch-codex': 'Codex 桌面端启动',
  'models:list': '可用模型读取',
  'window:set-mode': '窗口模式切换',
  'window:set-theme': '界面主题切换',
  'external:open': '外部链接打开',
  'update:get-state': '主程序更新状态读取',
  'update:startup': '主程序启动更新',
  'update:check': '主程序更新检查',
  'update:download': '主程序更新下载',
  'update:install': '主程序更新安装',
  'sessions:list': 'Codex 会话列表读取',
  'sessions:detail': 'Codex 会话详情读取',
  'sessions:export': 'Codex 会话导出',
  'sessions:archive': 'Codex 会话归档',
  'sessions:restore': 'Codex 会话恢复',
  'provider-sessions:list': 'AI 工具会话列表读取',
  'provider-sessions:detail': 'AI 工具会话详情读取',
  'provider-sessions:export': 'AI 工具会话导出',
  'settings:get': '应用设置读取',
  'settings:save': '应用设置保存',
  'diagnostics:run': '系统诊断',
  'diagnostics:export': '诊断报告导出',
  'runtime-logs:list': '运行日志读取',
  'runtime-logs:copy-feedback': '脱敏反馈文本复制',
  'runtime-logs:export-feedback': '反馈报告导出',
  'runtime-logs:open-directory': '日志目录打开',
  'runtime-logs:clear': '运行日志清空',
  'runtime-logs:renderer-error': '渲染进程异常上报',
  'backups:list': '配置备份列表读取',
  'backups:create': '配置备份创建',
  'backups:inspect': '配置备份详情读取',
  'backups:restore': '配置备份恢复',
  'backups:delete': '配置备份删除',
  'mcp:list': 'MCP 列表读取',
  'mcp:add': 'MCP 添加',
  'mcp:remove': 'MCP 删除',
  'mcp:login': 'MCP 登录',
  'mcp:logout': 'MCP 退出登录',
  'skills:list': 'Skills 列表读取',
  'skills:import': 'Skill 导入',
  'skills:toggle': 'Skill 启用状态修改',
  'skills:uninstall': 'Skill 卸载',
  'plugins:list': 'Plugins 列表读取',
  'plugins:add': 'Plugin 安装',
  'plugins:remove': 'Plugin 卸载',
  'plugins:toggle': 'Plugin 启用状态修改',
  'marketplaces:add': '扩展市场添加',
  'marketplaces:upgrade': '扩展市场更新',
  'marketplaces:remove': '扩展市场删除',
  'extensions:list': 'AI 工具扩展列表读取',
  'extensions:list-all': '全部 AI 工具扩展读取',
  'extensions:mutate': 'AI 工具扩展操作',
  'account:get-status': '星芒账号服务状态读取',
  'account:login': '星芒账号登录',
  'account:logout': '星芒账号退出登录',
  'account:get-session': '星芒账号会话状态读取',
  'account:get-balance': '星芒账号余额查询',
  'account:provision-cli-key': 'CLI Key 签发',
  'account:register': '星芒账号注册',
  'account:send-verification-code': '星芒账号邮箱验证码发送',
  'account:send-reset-code': '星芒账号密码重置邮件发送',
  'account:reset-password': '星芒账号密码重置',
  'account:get-profile': '星芒账号资料读取',
  'account:get-usage': '星芒账号用量明细读取',
  'account:list-keys': '星芒账号 Key 列表读取',
  'account:revoke-key': '星芒账号 Key 撤销',
  'account:change-password': '星芒账号密码修改',
  'canvas:open': '无限画布窗口打开',
}

const quietIpcSuccessChannels = new Set([
  'system:scan',
  'startup:codex-readiness',
  'config:get',
  'config:reveal-api-key',
  'repository:get-context',
  'setup:codex-status',
  'desktop:codex-status',
  'window:set-mode',
  'window:set-theme',
  'update:get-state',
  'update:startup',
  'settings:get',
  'runtime-logs:list',
  'runtime-logs:renderer-error',
  // Frequent read-style checks, or -- get-status/get-balance can be polled by
  // a status widget -- and provision-cli-key returns a plaintext secret to
  // the renderer exactly like config:reveal-api-key above (I3/I13): logging
  // its success detail would put the CLI key straight into the log file.
  'account:get-status',
  'account:get-session',
  'account:get-balance',
  'account:provision-cli-key',
  // account:reset-password's result carries a server-generated plaintext
  // password (NewApiResetPasswordResult) -- exactly as sensitive as the CLI
  // key above, same I3/I13 reasoning.
  'account:reset-password',
  // get-profile's result carries email/aff_code -- PII, not a secret exactly,
  // but still not something that belongs in the plaintext runtime log
  // (I13). get-usage's result has its own `total` field, which
  // collectionSize() would otherwise surface into the log via itemCount; not
  // sensitive on its own, but grouped here for the same "account:* reads stay
  // quiet" consistency as get-status/get-session/get-balance above.
  'account:get-profile',
  'account:get-usage',
  // list-keys' DTO is metadata-only (I3 -- see NewApiAccountKey's own
  // comment for the whitelist), so nothing here is secret either; grouped in
  // for the same "account:* reads stay quiet" consistency as get-usage
  // immediately above rather than being the one account:* read that logs
  // differently from its siblings.
  'account:list-keys',
  // change-password's *input* carries two plaintext passwords (args[0], not
  // the result -- the result is just {changed:true}, I3-safe on its own).
  // ipcLogDetail/ipcSuccessMessage happen to never spread args[0] generically
  // today, but that is true by omission, not by contract -- quieting this
  // channel outright removes the need to keep re-verifying that invariant
  // every time either function gains a new per-channel branch (I13).
  'account:change-password',
])

function providerDisplayName(value: unknown): string | null {
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

function ipcSuccessMessage(channel: string, args: unknown[], result: unknown): string {
  const label = ipcOperationLabels[channel] ?? channel
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
  if (channel === 'config:save' && provider) return `${provider} 配置已保存`
  if (channel === 'cli:install' && provider) return `${provider} 安装或更新已完成`
  if (channel === 'runtime:install-node') return 'Node.js LTS 自动安装完成'
  if (channel === 'cli:uninstall' && provider) return `${provider} 卸载已完成`
  if (channel === 'cli:check-update' && provider) return `${provider} 更新检查已完成`
  if (channel === 'desktop:uninstall-codex') return 'Codex 桌面端卸载已完成'
  if (channel === 'cli:launch' && provider) return `${provider} 终端已打开`
  if (channel === 'models:list' && count !== null) return `可用模型读取完成，共 ${count} 个`
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

function ipcLogDetail(channel: string, args: unknown[], result: unknown, durationMs: number): Record<string, unknown> {
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
  const count = collectionSize(result)
  if (count !== null) detail.itemCount = count
  if (channel === 'diagnostics:run' && isRecord(result) && isRecord(result.counts)) {
    detail.counts = result.counts
  }
  return detail
}

function ipcSuccessLevel(channel: string): 'debug' | 'info' {
  return /:(?:get|get-state|list|list-all|detail|status|inspect)$/.test(channel) ? 'debug' : 'info'
}

export function registerIpcHandlers(options: IpcRegistrationOptions): () => void {
  const registeredChannels: string[] = []
  const externalShell = options.externalShell ?? createExternalShellLauncher()
  const registerTrustedHandler = (channel: string, handler: TrustedIpcHandler): void => {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (event, ...args) => {
      const startedAt = Date.now()
      const recordSuccess = (result: unknown) => {
        if (quietIpcSuccessChannels.has(channel)) return
        options.runtimeLog.log(
          ipcSuccessLevel(channel),
          'ipc',
          channel,
          ipcSuccessMessage(channel, args, result),
          ipcLogDetail(channel, args, result, Date.now() - startedAt),
        )
      }
      const recordFailure = (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        const label = ipcOperationLabels[channel] ?? channel
        options.runtimeLog.log('error', 'ipc', channel, `${label}失败：${reason || '未知错误'}`, {
          durationMs: Date.now() - startedAt,
          error,
        })
      }
      const senderUrl = event.senderFrame?.url ?? event.sender.getURL()
      if (!isTrustedIpcSenderUrl(senderUrl, options.urlPolicy)) {
        options.runtimeLog.log('warn', 'security', 'ipc.denied', '已拒绝非应用页面的 IPC 请求', { channel })
        throw new Error('已拒绝来自非应用页面的操作请求')
      }
      try {
        const result = handler(event, ...args)
        if (isPromiseLike(result)) {
          return Promise.resolve(result).then((value) => {
            recordSuccess(value)
            return value
          }, (error: unknown) => {
            recordFailure(error)
            throw error
          })
        }
        recordSuccess(result)
        return result
      } catch (error) {
        recordFailure(error)
        throw error
      }
    })
  }

  const service = options.systemService
  const accountService = options.accountService ?? createNewApiClient()
  const unsubscribeUpdates = options.updaterService.subscribe(options.broadcastUpdate)
  registerTrustedHandler('platform:get-capabilities', () => platformCapabilitiesFor())
  registerTrustedHandler('system:scan', async (_event, forceRefresh: unknown) => {
    if (forceRefresh !== undefined && typeof forceRefresh !== 'boolean') {
      throw new Error('更新检查参数格式错误')
    }
    const scanned = await service.scanSystem(forceRefresh === true)
    const snapshot = options.transformSystemSnapshot?.(scanned) ?? scanned
    options.runtimeLog.log('info', 'system', 'scan.completed', '本机环境与 AI 工具检测完成', {
      runtime: Object.fromEntries(Object.entries(snapshot.runtime).map(([id, status]) => [id, {
        installed: status.installed,
        version: status.version,
      }])),
      clis: Object.fromEntries(Object.entries(snapshot.clis).map(([id, status]) => [id, {
        installed: status.installed,
        version: status.version,
        installDirectory: status.installDirectory,
        latestVersion: status.latestVersion,
        updateState: status.updateState,
        updateError: status.updateError,
      }])),
      codexDesktop: {
        installed: snapshot.desktopApps.codex.installed,
        appVersion: snapshot.desktopApps.codex.appVersion,
        version: snapshot.desktopApps.codex.version,
        mirrorVersion: snapshot.desktopApps.codex.mirrorVersion,
        mirrorUpdateAvailable: snapshot.desktopApps.codex.mirrorUpdateAvailable,
        mirrorError: snapshot.desktopApps.codex.mirrorError,
        installDirectory: snapshot.desktopApps.codex.installDirectory,
        latestVersion: snapshot.desktopApps.codex.latestVersion,
        updateState: snapshot.desktopApps.codex.updateState,
        updateError: snapshot.desktopApps.codex.updateError,
      },
    })
    for (const [provider, status] of Object.entries(snapshot.clis)) {
      if (!status.updateError) continue
      const name = isProviderId(provider) ? cliCatalog[provider].name : provider
      options.runtimeLog.log(
        'warn',
        'system',
        'cli.update-check.failed',
        `${name} 更新检测失败：${status.updateError}`,
        { provider, installedVersion: status.version },
      )
    }
    if (snapshot.desktopApps.codex.updateError) {
      options.runtimeLog.log(
        'warn',
        'system',
        'desktop.update-check.failed',
        `Codex 桌面端更新检测失败：${snapshot.desktopApps.codex.updateError}`,
        { installedVersion: snapshot.desktopApps.codex.version },
      )
    }
    return snapshot
  })
  registerTrustedHandler('startup:codex-readiness', () => (
    service.inspectCodexReadiness(options.previewOnboarding)
  ))
  registerTrustedHandler('config:get', () => service.getConfig(options.previewOnboarding))
  registerTrustedHandler('config:reveal-api-key', (_event, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error('未知的 CLI 类型')
    return service.revealApiKey(provider, options.previewOnboarding)
  })
  registerTrustedHandler('config:save', (_event, payload: unknown) => (
    service.saveConfig(parseConfigSavePayload(payload), options.previewOnboarding)
  ))
  registerTrustedHandler('workspace:choose', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '选择 CLI 工作目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    const workspace = result.filePaths[0]
    await service.writeStoredConfig({ ...service.readStoredConfig(), workspace })
    options.extensionService.setRepositoryContext(workspace)
    options.providerExtensionService.setRepositoryRoot(workspace)
    return workspace
  })
  registerTrustedHandler('repository:get-context', () => options.extensionService.getRepositoryContext())
  registerTrustedHandler('runtime:install-node', async (event) => {
    options.runtimeLog.log('info', 'maintenance', 'runtime.node.install.started', '开始自动安装 Node.js LTS')
    try {
      const result = await service.installNodeRuntime(event.sender)
      options.runtimeLog.log('info', 'maintenance', 'runtime.node.install.completed', 'Node.js LTS 自动安装完成', {
        method: result.method,
        source: result.source,
        version: result.version,
        architecture: result.architecture,
        systemRestartRequired: result.systemRestartRequired,
      })
      return result
    } catch (error) {
      options.runtimeLog.exception('maintenance', 'runtime.node.install.failed', error)
      throw error
    }
  })
  registerTrustedHandler('cli:install', async (event, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error('未知的 CLI 类型')
    const providerName = cliCatalog[provider].name
    options.runtimeLog.log('info', 'maintenance', 'cli.install.started', `开始安装或更新 ${providerName}`, { provider })
    try {
      await service.installCli(provider, event.sender)
      options.runtimeLog.log('info', 'maintenance', 'cli.install.completed', `${providerName} 安装或更新完成`, { provider })
    } catch (error) {
      options.runtimeLog.exception('maintenance', 'cli.install.failed', error, { provider })
      throw error
    }
  })
  registerTrustedHandler('cli:uninstall', async (_event, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error('未知的 CLI 类型')
    const providerName = cliCatalog[provider].name
    options.runtimeLog.log('info', 'maintenance', 'cli.uninstall.started', `开始卸载 ${providerName}`, { provider })
    try {
      const result = await service.uninstallCli(provider)
      options.runtimeLog.log('info', 'maintenance', 'cli.uninstall.completed', `${providerName} 卸载完成`, {
        provider,
        outcome: result.outcome,
        previousVersion: result.previousVersion,
      })
      return result
    } catch (error) {
      options.runtimeLog.exception('maintenance', 'cli.uninstall.failed', error, { provider })
      throw error
    }
  })
  registerTrustedHandler('cli:check-update', (_event, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error('未知的 CLI 类型')
    return service.inspectCliUpdate(provider, true)
  })
  registerTrustedHandler('setup:codex-status', () => service.inspectCodexSetupStatus())
  registerTrustedHandler('desktop:install-codex', (event) => service.installCodexDesktop(event.sender))
  registerTrustedHandler('desktop:uninstall-codex', () => service.uninstallCodexDesktop())
  registerTrustedHandler('desktop:check-update-codex', () => service.inspectCodexDesktopUpdate(true))
  registerTrustedHandler('cli:launch', (_event, provider: unknown, workspace: unknown) => {
    if (!isProviderId(provider)) throw new Error('未知的 CLI 类型')
    const stored = service.readStoredConfig()
    return service.launchProvider(provider, parseWorkspace(workspace, stored.workspace))
  })
  registerTrustedHandler('desktop:codex-status', () => service.inspectCodexDesktop())
  registerTrustedHandler('desktop:launch-codex', (event, mode: unknown) => (
    service.launchCodexDesktop(parseDesktopLaunchMode(mode), event.sender)
  ))
  registerTrustedHandler('models:list', (_event, apiKey: unknown) => {
    if (typeof apiKey !== 'string' || apiKey.length > 4_096) {
      throw new Error('API Key 格式错误')
    }
    return service.fetchAvailableModels(apiKey)
  })
  registerTrustedHandler('window:set-mode', (event, mode: unknown) => {
    if (mode !== 'onboarding' && mode !== 'dashboard') throw new Error('未知的窗口模式')
    options.setWindowMode(event.sender, mode)
  })
  registerTrustedHandler('window:set-theme', async (event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark') throw new Error('未知的主题')
    options.setWindowTheme(event.sender, theme)
    const stored = service.readStoredConfig()
    await service.writeStoredConfig({ ...stored, theme })
  })
  registerTrustedHandler('external:open', async (_event, url: unknown) => {
    if (
      typeof url !== 'string'
      || !isAllowedExternalUrl(url, options.externalUrlAllowlist)
    ) {
      throw new Error('不允许打开该链接')
    }
    await externalShell.openExternal(url)
    return true
  })
  registerTrustedHandler('update:get-state', () => options.updaterService.getState())
  registerTrustedHandler('update:startup', () => options.updaterService.startup())
  registerTrustedHandler('update:check', () => options.updaterService.check())
  registerTrustedHandler('update:download', () => options.updaterService.download())
  registerTrustedHandler('update:install', () => options.updaterService.install())
  registerTrustedHandler('sessions:list', (_event, query: unknown) => (
    options.sessionsService.list(parseSessionListQuery(query))
  ))
  registerTrustedHandler('sessions:detail', (_event, sessionId: unknown) => (
    options.sessionsService.detail(parseSessionId(sessionId))
  ))
  registerTrustedHandler('sessions:export', async (_event, sessionId: unknown) => {
    const id = parseSessionId(sessionId)
    const result = await dialog.showSaveDialog({
      title: '导出 Codex 会话',
      defaultPath: `codex-session-${id.slice(0, 8)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    return options.sessionsService.exportMarkdown(id, result.filePath)
  })
  registerTrustedHandler('sessions:archive', (_event, sessionId: unknown) => (
    options.sessionsService.archive(parseSessionId(sessionId))
  ))
  registerTrustedHandler('sessions:restore', (_event, sessionId: unknown) => (
    options.sessionsService.restore(parseSessionId(sessionId))
  ))
  registerTrustedHandler('provider-sessions:list', (_event, query: unknown) => (
    options.providerSessionsService.list(parseProviderSessionListQuery(query))
  ))
  registerTrustedHandler('provider-sessions:detail', (_event, sessionId: unknown) => (
    options.providerSessionsService.detail(requiredString(sessionId, '会话 ID', 256))
  ))
  registerTrustedHandler('provider-sessions:export', async (_event, sessionId: unknown) => {
    const id = requiredString(sessionId, '会话 ID', 256)
    const safeId = id.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48)
    const result = await dialog.showSaveDialog({
      title: '导出 AI 会话',
      defaultPath: `ai-session-${safeId}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    return options.providerSessionsService.exportMarkdown(id, result.filePath)
  })
  registerTrustedHandler('settings:get', () => service.readStoredConfig())
  registerTrustedHandler('settings:save', async (event, settings: unknown) => {
    const next = parseSettings(settings)
    await service.writeStoredConfig(next)
    options.extensionService.setRepositoryContext(next.workspace)
    options.providerExtensionService.setRepositoryRoot(next.workspace)
    options.setWindowTheme(event.sender, next.theme)
    return next
  })
  registerTrustedHandler('diagnostics:run', () => options.diagnosticsService.run())
  registerTrustedHandler('diagnostics:export', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出脱敏诊断报告',
      defaultPath: `xingmang-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(
      result.filePath,
      options.diagnosticsService.exportLatest(),
      '诊断报告导出文件',
    )
    return { outputPath: result.filePath }
  })
  registerTrustedHandler('runtime-logs:list', (_event, limit: unknown) => {
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 2_000)) {
      throw new Error('日志数量格式错误')
    }
    return options.runtimeLog.snapshot(limit as number | undefined)
  })
  registerTrustedHandler('runtime-logs:copy-feedback', async () => {
    const [report, snapshot] = await Promise.all([
      options.runtimeLog.feedbackReport(),
      options.runtimeLog.snapshot(),
    ])
    clipboard.writeText(report)
    return { entries: snapshot.total }
  })
  registerTrustedHandler('runtime-logs:export-feedback', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出反馈与诊断',
      defaultPath: `xingmang-feedback-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(
      result.filePath,
      await options.runtimeLog.feedbackReport(),
      '反馈报告导出文件',
    )
    return { outputPath: result.filePath }
  })
  registerTrustedHandler('runtime-logs:open-directory', async () => {
    ensureSafeDataDirectory(options.runtimeLog.directory, '运行日志目录')
    await externalShell.openPath(options.runtimeLog.directory)
    return true
  })
  registerTrustedHandler('runtime-logs:clear', () => options.runtimeLog.clear())
  registerTrustedHandler('runtime-logs:renderer-error', (_event, payload: unknown) => {
    const error = parseRendererError(payload)
    options.runtimeLog.log('error', 'renderer', 'renderer.error', error.message, {
      context: error.context ?? null,
      stack: error.stack ?? null,
    })
  })
  registerTrustedHandler('backups:list', () => options.backupStore.list())
  registerTrustedHandler('backups:create', (_event, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error('未知的配置类型')
    return options.backupStore.create(provider, 'manual')
  })
  registerTrustedHandler('backups:inspect', (_event, id: unknown) => (
    options.backupStore.inspect(requiredString(id, '备份 ID', 128))
  ))
  registerTrustedHandler('backups:restore', (_event, id: unknown) => (
    options.backupStore.restore(requiredString(id, '备份 ID', 128))
  ))
  registerTrustedHandler('backups:delete', (_event, id: unknown) => (
    options.backupStore.delete(requiredString(id, '备份 ID', 128))
  ))
  registerTrustedHandler('mcp:list', () => options.extensionService.listMcpServers())
  registerTrustedHandler('mcp:add', (_event, input: unknown) => (
    options.extensionService.addMcpServer(parseMcpInput(input))
  ))
  registerTrustedHandler('mcp:remove', (_event, name: unknown) => (
    options.extensionService.removeMcpServer(requiredString(name, 'MCP 名称', 128))
  ))
  registerTrustedHandler('mcp:login', (_event, name: unknown) => (
    options.extensionService.loginMcpServer(requiredString(name, 'MCP 名称', 128))
  ))
  registerTrustedHandler('mcp:logout', (_event, name: unknown) => (
    options.extensionService.logoutMcpServer(requiredString(name, 'MCP 名称', 128))
  ))
  registerTrustedHandler('skills:list', () => options.extensionService.listSkills())
  registerTrustedHandler('skills:import', (_event, input: unknown) => (
    options.extensionService.importSkill(parseSkillInput(input))
  ))
  registerTrustedHandler('skills:toggle', (_event, skillPath: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Skill 状态格式错误')
    return options.extensionService.setSkillEnabled(requiredString(skillPath, 'Skill 路径', 32_767), enabled)
  })
  registerTrustedHandler('skills:uninstall', (_event, skillPath: unknown) => (
    options.extensionService.uninstallSkill(requiredString(skillPath, 'Skill 路径', 32_767))
  ))
  registerTrustedHandler('plugins:list', () => options.extensionService.listPlugins())
  registerTrustedHandler('plugins:add', (_event, selector: unknown) => (
    options.extensionService.addPlugin(requiredString(selector, 'Plugin ID', 256))
  ))
  registerTrustedHandler('plugins:remove', (_event, selector: unknown) => (
    options.extensionService.removePlugin(requiredString(selector, 'Plugin ID', 256))
  ))
  registerTrustedHandler('plugins:toggle', (_event, selector: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Plugin 状态格式错误')
    return options.extensionService.setPluginEnabled(requiredString(selector, 'Plugin ID', 256), enabled)
  })
  registerTrustedHandler('marketplaces:add', (_event, input: unknown) => (
    options.extensionService.addMarketplace(parseMarketplaceInput(input))
  ))
  registerTrustedHandler('marketplaces:upgrade', (_event, name: unknown) => (
    options.extensionService.upgradeMarketplace(optionalString(name, '市场名称', 256))
  ))
  registerTrustedHandler('marketplaces:remove', (_event, name: unknown) => (
    options.extensionService.removeMarketplace(requiredString(name, '市场名称', 256))
  ))
  const recordExtensionWarnings = (snapshot: ProviderExtensionsSnapshot): ProviderExtensionsSnapshot => {
    if (snapshot.warnings.length > 0) {
      options.runtimeLog.log(
        'warn',
        'extensions',
        'list.degraded',
        `${cliCatalog[snapshot.provider].name} 扩展列表部分读取失败：${snapshot.warnings.join('；')}`,
        {
          provider: snapshot.provider,
          unavailable: Object.entries(snapshot.capabilities)
            .filter(([, capability]) => !capability.list)
            .map(([kind, capability]) => ({ kind, reason: capability.reason })),
        },
      )
    }
    return snapshot
  }
  registerTrustedHandler('extensions:list', async (_event, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error('未知的 AI 工具')
    return recordExtensionWarnings(await options.providerExtensionService.list(provider))
  })
  registerTrustedHandler('extensions:list-all', async () => {
    const snapshots = await options.providerExtensionService.listAll()
    return snapshots.map(recordExtensionWarnings)
  })
  registerTrustedHandler('extensions:mutate', (_event, input: unknown) => (
    options.providerExtensionService.mutate(parseProviderExtensionMutation(input))
  ))
  registerTrustedHandler('account:get-status', () => accountService.getStatus())
  registerTrustedHandler('account:login', (_event, input: unknown) => (
    accountService.login(parseAccountLoginInput(input))
  ))
  registerTrustedHandler('account:logout', () => accountService.logout())
  const accountSessionReady = options.accountSessionReady ?? Promise.resolve()
  registerTrustedHandler('account:get-session', async () => {
    // Guaranteed not to reject (see the option's own doc comment), but a
    // stray .catch() here costs nothing and means a future regression there
    // degrades to "restore didn't happen" instead of an unhandled rejection.
    await accountSessionReady.catch(() => undefined)
    return accountService.getSessionState()
  })
  registerTrustedHandler('account:get-balance', () => accountService.getBalance())
  registerTrustedHandler('account:provision-cli-key', () => accountService.provisionCliKey())
  registerTrustedHandler('account:register', (_event, input: unknown) => (
    accountService.register(parseAccountRegisterInput(input))
  ))
  registerTrustedHandler('account:send-verification-code', (_event, email: unknown) => (
    accountService.sendEmailVerification(parseAccountEmailInput(email))
  ))
  registerTrustedHandler('account:send-reset-code', (_event, email: unknown) => (
    accountService.sendPasswordResetEmail(parseAccountEmailInput(email))
  ))
  registerTrustedHandler('account:reset-password', (_event, input: unknown) => (
    accountService.resetPassword(parseAccountPasswordResetInput(input))
  ))
  registerTrustedHandler('account:get-profile', () => accountService.getProfile())
  registerTrustedHandler('account:get-usage', (_event, input: unknown) => (
    accountService.getUsage(parseAccountUsageQuery(input))
  ))
  registerTrustedHandler('account:list-keys', (_event, input: unknown) => (
    accountService.listKeys(parseAccountKeysQuery(input))
  ))
  registerTrustedHandler('account:revoke-key', (_event, id: unknown) => (
    accountService.revokeKey(parseAccountRevokeKeyId(id))
  ))
  registerTrustedHandler('account:change-password', (_event, input: unknown) => (
    accountService.changePassword(parseAccountChangePasswordInput(input))
  ))
  registerTrustedHandler('canvas:open', () => options.openCanvasWindow())

  return () => {
    unsubscribeUpdates()
    for (const channel of registeredChannels) ipcMain.removeHandler(channel)
  }
}
