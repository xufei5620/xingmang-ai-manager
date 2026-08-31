import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as TOML from '@iarna/toml'
import { providerBaseUrls, type ProviderId } from './catalog'
import { readBoundedUtf8FileSync } from './bounded-file'
import {
  defaultProviderConfigRoots,
  providerConfigRoot,
  type ProviderConfigRoots,
} from './codex-home'
import { identityFromCodexAuthTokens } from './official-account-identity'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'

const MAX_NATIVE_CONFIG_BYTES = 2 * 1024 * 1024

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
  dataDirectory: string
  dataDirectoryExists: boolean
  files: NativeConfigFile[]
  updatedAt: string | null
}

/** Renderer-safe projection. The raw key never crosses the IPC boundary. */
export interface NativeConfigSummary extends Omit<NativeConfigInspection, 'apiKey'> {
  apiKeyPreview: string | null
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

interface FilePlan {
  path: string
  content: string
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
    return readBoundedUtf8FileSync(filePath, MAX_NATIVE_CONFIG_BYTES, '配置文件')
  } catch {
    return null
  }
}

function requireConfigText(filePath: string, label: string): string | null {
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
  return readBoundedUtf8FileSync(filePath, MAX_NATIVE_CONFIG_BYTES, label)
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

function readToml(filePath: string): Record<string, unknown> | null {
  const content = readText(filePath)
  if (!content) return null
  try {
    return TOML.parse(content)
  } catch {
    return null
  }
}

function requireJson(filePath: string, label: string): Record<string, unknown> {
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
    throw new Error(`${label} 无法解析为 JSON，未执行修改`)
  }
  throw new Error(`${label} 不是有效的 JSON 对象，未执行修改`)
}

function requireToml(filePath: string, label: string): Record<string, unknown> {
  const content = requireConfigText(filePath, label)
  if (content === null) return {}
  try {
    return TOML.parse(content)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} 无法解析，未执行修改：${detail}`)
  }
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

function readProviderAuthType(provider: ProviderId, paths: string[]): string | undefined {
  return provider === 'gemini'
    ? nestedString(readJson(paths[0]), ['security', 'auth', 'selectedType'])
    : undefined
}

function readOfficialAccountIdentity(provider: ProviderId, paths: string[]) {
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

export function classifyCodexConfigProfile(
  parsed: Record<string, unknown> | null,
  siteBaseUrl: string,
): 'relay' | 'official' | 'empty' {
  if (!parsed || Object.keys(parsed).length === 0) return 'empty'
  const providerName = typeof parsed.model_provider === 'string' ? parsed.model_provider.trim() : ''
  const providers = parsed.model_providers
  const entry = providerName && isJsonRecord(providers) ? providers[providerName] : null
  const baseUrl = isJsonRecord(entry) && typeof entry.base_url === 'string' ? entry.base_url : ''
  if (baseUrl && normalizeUrl(baseUrl) === normalizeUrl(siteBaseUrl)) return 'relay'
  return 'official'
}

function cloneTomlRecord(parsed: Record<string, unknown>): Record<string, unknown> {
  return TOML.parse(TOML.stringify(parsed as Parameters<typeof TOML.stringify>[0]))
}

function withTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`
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
    if (entryBaseUrl && normalizeUrl(entryBaseUrl) === normalizeUrl(siteBaseUrl)) {
      delete providers[providerName]
    }
    if (Object.keys(providers).length === 0) delete parsed.model_providers
  }
  delete parsed.model_provider
  delete parsed.model
  delete parsed.review_model
}

function applyCodexRelayConfig(
  parsed: Record<string, unknown>,
  model: string,
  providerName: string,
  siteBaseUrl: string,
): void {
  parsed.model = model
  parsed.review_model = model
  parsed.model_provider = providerName
  const providerEntry = ensureRecord(ensureRecord(parsed, 'model_providers'), providerName)
  providerEntry.name = typeof providerEntry.name === 'string' && providerEntry.name.trim()
    ? providerEntry.name
    : providerName
  providerEntry.base_url = siteBaseUrl
  providerEntry.wire_api = 'responses'
  providerEntry.requires_openai_auth = true
  // Keep the Desktop permission picker interactive on fresh mirror installs.
  // Never override an explicit user policy such as `never`.
  if (parsed.approval_policy === undefined) parsed.approval_policy = 'on-request'
  if (parsed.sandbox_mode === undefined) parsed.sandbox_mode = 'workspace-write'
}

function buildCodexRelayConfigTemplate(
  model: string,
  providerName: string,
  siteBaseUrl: string,
): string {
  const providerKey = tomlTableKey(providerName)
  return [
    `model_provider = ${tomlString(providerName)}`,
    `model = ${tomlString(model)}`,
    `review_model = ${tomlString(model)}`,
    'model_reasoning_effort = "xhigh"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'disable_response_storage = true',
    'network_access = "enabled"',
    'windows_wsl_setup_acknowledged = true',
    'model_context_window = 1000000',
    'model_auto_compact_token_limit = 900000',
    '',
    `[model_providers.${providerKey}]`,
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(siteBaseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
    '[features]',
    'goals = true',
    '',
  ].join('\n')
}

function snapshotOfficialCodexConfigText(
  currentText: string,
  currentParsed: Record<string, unknown>,
  siteBaseUrl: string,
): string {
  if (classifyCodexConfigProfile(currentParsed, siteBaseUrl) === 'official') {
    return withTrailingNewline(currentText)
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
    throw new Error(`${label} 无法解析，未执行修改`)
  }
  return withTrailingNewline(text)
}

function createCodexRelayConfigPlans(
  model: string,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
  mode: NativeConfigSaveMode,
): FilePlan[] {
  const paths = codexConfigSnapshotPaths(roots)
  const plans: FilePlan[] = []
  const currentText = fs.existsSync(paths.active)
    ? requireConfigText(paths.active, '现有 Codex config.toml')
    : null
  let currentParsed: Record<string, unknown> | null = null
  if (currentText) {
    try {
      currentParsed = TOML.parse(currentText)
    } catch (error) {
      if (mode !== 'reset') {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`现有 Codex config.toml 无法解析，未执行修改：${detail}`)
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

  const storedRelay = currentKind === 'official' ? readStoredCodexConfig(paths.relay, '已保存的星芒 Codex 配置') : null
  let nextContent: string
  if (mode === 'reset') {
    nextContent = buildCodexRelayConfigTemplate(model, existingCodexProvider(paths.active), siteBaseUrls.codex)
  } else if (storedRelay) {
    const stored = TOML.parse(storedRelay)
    applyCodexRelayConfig(stored, model, existingCodexProvider(paths.relay), siteBaseUrls.codex)
    nextContent = tomlContent(stored)
  } else if (currentParsed) {
    applyCodexRelayConfig(currentParsed, model, existingCodexProvider(paths.active), siteBaseUrls.codex)
    nextContent = tomlContent(currentParsed)
  } else {
    nextContent = buildCodexRelayConfigTemplate(model, defaultCodexRelayProvider, siteBaseUrls.codex)
  }

  plans.push({ path: paths.relay, content: nextContent })
  plans.push({ path: paths.active, content: nextContent })
  return plans
}

function createCodexOfficialConfigPlans(
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
): FilePlan[] {
  const paths = codexConfigSnapshotPaths(roots)
  const plans: FilePlan[] = []
  const currentText = fs.existsSync(paths.active)
    ? requireConfigText(paths.active, '现有 Codex config.toml')
    : null
  if (!currentText) return plans
  const currentParsed = requireToml(paths.active, '现有 Codex config.toml')
  if (classifyCodexConfigProfile(currentParsed, siteBaseUrls.codex) === 'relay') {
    plans.push({ path: paths.relay, content: withTrailingNewline(currentText) })
  }
  const storedChatgpt = readStoredCodexConfig(paths.chatgpt, '已保存的 ChatGPT Codex 配置')
  if (storedChatgpt) {
    plans.push({ path: paths.active, content: storedChatgpt })
    return plans
  }
  const cleaned = cloneTomlRecord(currentParsed)
  stripCodexRelayFromConfig(cleaned, siteBaseUrls.codex)
  plans.push({ path: paths.active, content: tomlContent(cleaned) })
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

function createCodexRelayAuthPlans(apiKey: string, roots: ProviderConfigRoots): FilePlan[] {
  const paths = codexAuthSnapshotPaths(roots)
  const plans: FilePlan[] = []
  if (fs.existsSync(paths.active)) {
    const current = requireJson(paths.active, '现有 Codex auth.json')
    const chatgpt = snapshotCodexChatGptAuth(current)
    if (chatgpt) plans.push({ path: paths.chatgpt, content: jsonContent(chatgpt) })
  }
  const apikeyAuth = buildCodexApiKeyAuth(apiKey)
  plans.push({ path: paths.apikey, content: jsonContent(apikeyAuth) })
  plans.push({ path: paths.active, content: jsonContent(apikeyAuth) })
  return plans
}

function createCodexOfficialAuthPlans(roots: ProviderConfigRoots): FilePlan[] {
  const paths = codexAuthSnapshotPaths(roots)
  const current = fs.existsSync(paths.active) ? requireJson(paths.active, '现有 Codex auth.json') : null
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
    plans.push({ path: paths.active, content: jsonContent(current) })
  }
  return plans
}

function readCodexAuthMode(paths: string[]): 'apikey' | 'chatgpt' | null {
  const parsed = readJson(paths[1])
  const kind = classifyCodexAuthProfile(parsed)
  if (kind === 'apikey' || kind === 'chatgpt') return kind
  if (kind !== 'mixed') return null
  const mode = nestedString(parsed, ['auth_mode']).trim().toLowerCase()
  if (mode === 'apikey' || mode === 'chatgpt') return mode
  return 'chatgpt'
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
    matchesRelay: Boolean(apiKey && actualBaseUrl && normalizeUrl(actualBaseUrl) === normalizeUrl(baseUrl)),
    apiKey,
    model,
    ...(authType !== undefined ? { authType } : {}),
    officialAccountEmail: officialAccount.email,
    officialAccountPlan: officialAccount.planLabel,
    officialAccountRenewsAt: officialAccount.renewsAt,
    ...(provider === 'codex' ? { codexAuthMode: readCodexAuthMode(paths) } : {}),
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

function existingCodexProvider(configPath: string): string {
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

  if (typeof parsed.model_provider === 'string' && parsed.model_provider.trim()) {
    return parsed.model_provider.trim()
  }
  // A provider table without an explicit active selector is ambiguous. Never
  // hijack the first user-authored entry (Azure/custom relays are common);
  // use the stable OpenAI entry and let the merge path create it if needed.
  return 'OpenAI'
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function tomlContent(value: Record<string, unknown>): string {
  return TOML.stringify(value as Parameters<typeof TOML.stringify>[0])
}

function normalizeCodexWorkspaceKey(value: string): string {
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
  const wanted = normalizeCodexWorkspaceKey(workspace)
  const key = Object.keys(projects).find((candidate) => normalizeCodexWorkspaceKey(candidate) === wanted)
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
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  switch (provider) {
    case 'codex':
      return [
        ...createCodexRelayConfigPlans(model, roots, siteBaseUrls, 'reset'),
        ...createCodexRelayAuthPlans(apiKey, roots),
      ]
    case 'claude':
      return [{
        path: paths[0],
        content: jsonContent({
          env: {
            ANTHROPIC_AUTH_TOKEN: apiKey,
            ANTHROPIC_BASE_URL: siteBaseUrls.claude,
          },
          permissions: { defaultMode: 'bypassPermissions' },
          model,
          effortLevel: 'medium',
          skipDangerousModePermissionPrompt: true,
        }),
      }]
    case 'gemini':
      return [
        {
          path: paths[0],
          content: jsonContent({
            ide: { enabled: true },
            security: { auth: { selectedType: 'gemini-api-key' } },
          }),
        },
        {
          path: paths[1],
          content: [
            `GOOGLE_GEMINI_BASE_URL=${siteBaseUrls.gemini}`,
            `GEMINI_API_KEY=${apiKey}`,
            `GEMINI_MODEL=${model}`,
            '',
          ].join('\n'),
        },
      ]
    case 'grok':
      return [{
        path: paths[0],
        content: [
          '[models]',
          'default = "grok"',
          'web_search = "grok"',
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
        ].join('\n'),
      }]
  }
}

function createMergePlans(
  provider: ProviderId,
  apiKey: string,
  model: string,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  const initialPlans = new Map(
    createPlans(provider, apiKey, model, roots, siteBaseUrls).map((plan) => [plan.path, plan]),
  )
  const initial = (filePath: string): FilePlan => {
    const plan = initialPlans.get(filePath)
    if (!plan) throw new Error(`缺少初始配置模板：${filePath}`)
    return plan
  }

  switch (provider) {
    case 'codex':
      return [
        ...createCodexRelayConfigPlans(model, roots, siteBaseUrls, 'merge'),
        ...createCodexRelayAuthPlans(apiKey, roots),
      ]
    case 'claude': {
      if (!fs.existsSync(paths[0])) return [initial(paths[0])]
      const parsed = requireJson(paths[0], '现有 Claude settings.json')
      const env = ensureRecord(parsed, 'env')
      env.ANTHROPIC_AUTH_TOKEN = apiKey
      env.ANTHROPIC_BASE_URL = siteBaseUrls.claude
      parsed.model = model
      return [{ path: paths[0], content: jsonContent(parsed) }]
    }
    case 'gemini': {
      const plans: FilePlan[] = []
      if (!fs.existsSync(paths[0])) {
        plans.push(initial(paths[0]))
      } else {
        const parsed = requireJson(paths[0], '现有 Gemini settings.json')
        // Gemini CLI keeps the auth strategy in settings.json. Updating only
        // .env after a prior OAuth login leaves the UI looking configured while
        // the CLI continues to authenticate with Google, so merge must restore
        // the API-key selector just like reset does.
        ensureRecord(ensureRecord(parsed, 'security'), 'auth').selectedType = 'gemini-api-key'
        plans.push({ path: paths[0], content: jsonContent(parsed) })
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
            GEMINI_MODEL: model,
          }),
        })
      }
      return plans
    }
    case 'grok': {
      if (!fs.existsSync(paths[0])) return [initial(paths[0])]
      const parsed = requireToml(paths[0], '现有 Grok config.toml')
      const defaultModel = nestedString(parsed, ['models', 'default'])
      if (!defaultModel) {
        throw new Error('现有 Grok 配置缺少默认模型，请选择“重置为初始配置”')
      }
      const models = ensureRecord(parsed, 'model')
      const target = models[defaultModel]
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new Error('现有 Grok 默认模型配置无效，请选择“重置为初始配置”')
      }
      const targetModel = target as Record<string, unknown>
      targetModel.api_key = apiKey
      targetModel.model = model
      targetModel.base_url = siteBaseUrls.grok
      return [{ path: paths[0], content: tomlContent(parsed) }]
    }
  }
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

interface PreparedFilePlan extends FilePlan {
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
  const root = path.resolve(rootDirectory)
  const resolved = path.resolve(filePath)
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
  })
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
        assertSafeSourceAndTarget(rollbackPath, plan.path, providerRoot)
        fs.renameSync(rollbackPath, plan.path)
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

function executeFilePlans(
  plans: FilePlan[],
  hooks: NativeConfigWriteHooks,
  providerRoot: string,
): NativeConfigSaveResult {
  const prepared = prepareFilePlans(plans, providerRoot)
  const committed: PreparedFilePlan[] = []

  try {
    // No target is touched until every new file has been written successfully.
    for (const plan of prepared) {
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
      assertSafeSourceAndTarget(plan.temporaryPath, plan.path, providerRoot)
      hooks.beforeReplace?.(plan.path, index)
      assertSafeSourceAndTarget(plan.temporaryPath, plan.path, providerRoot)
      fs.renameSync(plan.temporaryPath, plan.path)
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

  const plans = mode === 'merge'
    ? createMergePlans(provider, apiKey, model, roots, siteBaseUrlsInput)
    : createPlans(provider, apiKey, model, roots, siteBaseUrlsInput)

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

/**
 * 星芒中转和官方订阅都能启动；自定义第三方地址不行。
 * Grok 没有官方登录，没配星芒 Key 时也拦下。
 */
export function canLaunchManagedProvider(
  inspection: Pick<NativeConfigInspection, 'hasApiKey' | 'matchesRelay'>,
  provider: ProviderId,
): boolean {
  const mode = providerAccountMode(inspection)
  if (mode === 'relay') return true
  return mode === 'official' && providerSupportsOfficialAccount(provider)
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
      return 'Grok CLI 尚未配置星芒 AI，请先完成配置'
  }
}

/** Grok(xAI CLI)只有 API Key 一种认证方式,没有可切回的官方订阅。 */
export function providerSupportsOfficialAccount(provider: ProviderId): boolean {
  return provider !== 'grok'
}

function officialAccountUnsupported(provider: ProviderId): never {
  throw new Error(
    provider === 'grok'
      ? 'Grok CLI 只支持 API Key 登录，没有可切换的官方订阅账号'
      : `暂不支持切换 ${provider} 的账号来源`,
  )
}

/**
 * 构造"切回官方订阅"的文件计划。只对**已存在**的文件出计划:文件不存在
 * 意味着本来就没有中转配置可收回,凭空创建反而会写出一份用户没要过的配置。
 */
function createOfficialAccountPlans(
  provider: ProviderId,
  roots: ProviderConfigRoots,
  siteBaseUrls: Record<ProviderId, string>,
): FilePlan[] {
  const paths = providerConfigPaths(provider, roots)
  switch (provider) {
    case 'codex':
      return [
        ...createCodexOfficialConfigPlans(roots, siteBaseUrls),
        ...createCodexOfficialAuthPlans(roots),
      ]
    case 'claude': {
      if (!fs.existsSync(paths[0])) return []
      const parsed = requireJson(paths[0], '现有 Claude settings.json')
      const env = parsed.env
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        const envRecord = env as Record<string, unknown>
        delete envRecord.ANTHROPIC_AUTH_TOKEN
        delete envRecord.ANTHROPIC_BASE_URL
        if (Object.keys(envRecord).length === 0) delete parsed.env
      }
      delete parsed.model
      return [{ path: paths[0], content: jsonContent(parsed) }]
    }
    case 'gemini': {
      const plans: FilePlan[] = []
      if (fs.existsSync(paths[0])) {
        const parsed = requireJson(paths[0], '现有 Gemini settings.json')
        const auth = ensureRecord(ensureRecord(parsed, 'security'), 'auth')
        auth.selectedType = 'oauth-personal'
        plans.push({ path: paths[0], content: jsonContent(parsed) })
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
    case 'grok':
      return officialAccountUnsupported(provider)
  }
}

/**
 * 把某个 CLI 切回用户自己的官方订阅账号。返回值与 saveProviderConfig 同形,
 * 调用方拿到的是同一套备份/写入清单。
 *
 * 前置校验故意严格:当前不是星芒中转就直接拒绝,而不是"尽力而为地删几个
 * 键"——后者在用户自接第三方中转时会把别人的配置改坏。
 */
export function switchProviderToOfficialAccount(
  provider: ProviderId,
  rootsInput: ProviderConfigRoots = defaultProviderConfigRoots(),
  hooks: NativeConfigWriteHooks = {},
  siteBaseUrlsInput: Record<ProviderId, string> = providerBaseUrls,
): NativeConfigSaveResult {
  if (!providerSupportsOfficialAccount(provider)) officialAccountUnsupported(provider)

  const roots = normalizeProviderConfigRoots(rootsInput)
  const providerRoot = providerConfigRoot(provider, roots)
  const configuredPaths = providerConfigPaths(provider, roots)
  for (const filePath of configuredPaths) assertSafeConfigPath(filePath, providerRoot, 'file')

  const mode = providerAccountMode(inspectProviderConfig(provider, roots, siteBaseUrlsInput))
  if (mode === 'official') throw new Error('当前已经在使用你自己的官方订阅账号，无需切换')
  if (mode === 'unknown') {
    throw new Error('当前配置不是星芒中转（可能是你自己填的第三方地址），为避免改坏配置已取消切换')
  }

  const plans = createOfficialAccountPlans(provider, roots, siteBaseUrlsInput)
  if (plans.length === 0) throw new Error('没有找到可切换的配置文件')

  assertNoReparseComponents(path.dirname(providerRoot), 'Provider 配置根目录')
  ensureSafeDataDirectory(providerRoot, 'Provider 配置根目录')
  return executeFilePlans(plans, hooks, providerRoot)
}
