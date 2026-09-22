import path from 'node:path'
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { executeFilePlans, type NativeConfigWriteHooks } from './config-files'
import { ensureSafeDataDirectory, readSafeUtf8FileSync } from './safe-local-data'
import type { ExternalClientConnectionStatus } from './external-client-contract'

/** 外部客户端不属于四个 CLI Provider，凭据由服务层解析后传入。 */
export type ExternalToolId = 'workbuddy' | 'claudeDesktop' | 'opencode'
export type ExternalToolPlatform = 'win32' | 'darwin' | 'linux'

export interface ExternalToolPathRoots {
  userHome: string
  appData?: string
  configHome?: string
}

export interface ExternalToolConfigOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  protocol?: 'responses' | 'chat-completions'
}

export interface ExternalToolConfigResult {
  tool: ExternalToolId
  path: string
  content: string
  format: 'json'
  /** 表示配置格式支持中转，不代表已经通过真实客户端连接验收。 */
  supportsRelay: boolean
}

export interface ExternalToolConfigSaveResult {
  path: string
  backups: string[]
  files: string[]
  supportsRelay: boolean
}

const MAX_EXTERNAL_CONFIG_BYTES = 2 * 1024 * 1024
type JsonObject = Record<string, unknown>
type JsonConfig = JsonObject | unknown[]
type ConfigEdit = { path: string[]; value: unknown }

/** Claude Desktop 的推理网关由独立模块管理，不向 CLI 配置路径写入。 */
export function assertExternalToolImplemented(tool: ExternalToolId): asserts tool is 'workbuddy' | 'opencode' {
  if (tool === 'claudeDesktop') throw new Error('Claude Desktop 请使用第三方推理网关配置，未修改文件')
  if (tool !== 'workbuddy' && tool !== 'opencode') throw new Error('不支持的外部客户端，未修改文件')
}

/** 仅计算默认全局路径；保存时另外解析 OpenCode 的 JSONC / 旧版配置优先级。 */
export function externalToolConfigPath(
  tool: ExternalToolId,
  platform: ExternalToolPlatform,
  input: ExternalToolPathRoots,
): string {
  assertExternalToolImplemented(tool)
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const userHome = pathApi.resolve(input.userHome)
  if (tool === 'workbuddy') return pathApi.join(userHome, '.workbuddy', 'models.json')
  return pathApi.join(input.configHome ? pathApi.resolve(input.configHome) : pathApi.join(userHome, '.config'), 'opencode', 'opencode.json')
}

function configError(detail: string): never {
  throw new Error(`外部客户端配置${detail}，未执行修改`)
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) configError(`${label}必须是 JSON 对象`)
  return value as JsonObject
}

function optionalObject(value: unknown, label: string): JsonObject {
  return value === undefined ? Object.create(null) as JsonObject : object(value, label)
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) configError(`${label}必须是字符串数组`)
  return value as string[]
}

function assertUniqueProperties(node: Node): void {
  if (node.type === 'object') {
    const names = new Set<string>()
    for (const property of node.children ?? []) {
      const name = property.children?.[0]?.value as string
      if (names.has(name)) configError('包含重复字段')
      names.add(name)
    }
  }
  for (const child of node.children ?? []) assertUniqueProperties(child)
}

function parseConfig(tool: 'opencode', existing: string | null): JsonObject
function parseConfig(tool: ExternalToolId, existing: string | null): JsonConfig
function parseConfig(tool: ExternalToolId, existing: string | null): JsonConfig {
  if (existing === null) return tool === 'workbuddy' ? [] : {}
  const errors: ParseError[] = []
  const tree = parseTree(existing, errors, { allowTrailingComma: tool === 'opencode', disallowComments: tool !== 'opencode' })
  if (!tree || errors.length) configError('无法解析为有效 JSON')
  assertUniqueProperties(tree)
  const value: unknown = getNodeValue(tree)
  return tool === 'workbuddy' && Array.isArray(value) ? value : object(value, '根节点')
}

function normalizedOptions(tool: ExternalToolId, options: ExternalToolConfigOptions) {
  for (const key of ['apiKey', 'baseUrl', 'model'] as const) {
    const value = options[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value))) {
      configError(`${key}必须是非空单行字符串`)
    }
  }
  const protocol = options.protocol ?? 'chat-completions'
  if (protocol !== 'responses' && protocol !== 'chat-completions') configError('协议不受支持')
  if (tool === 'workbuddy' && protocol !== 'chat-completions') configError('WorkBuddy 仅支持 Chat Completions 协议')
  const model = options.model?.trim() ?? 'gpt-5.2'
  if (model.length > 256 || /\s/.test(model)) configError('模型 ID 无效')
  let url: URL
  try { url = new URL(options.baseUrl?.trim() ?? 'https://xm.solov.cc/v1') } catch { configError('API 地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) configError('API 地址必须是无认证信息、查询参数和片段的 HTTP(S) 地址')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/, '')
  const baseUrl = url.toString().replace(/\/+$/, '')
  return { model, baseUrl, apiKey: options.apiKey?.trim(), protocol }
}

function applyConfigEdits(existing: string | null, edits: ConfigEdit[]): string {
  let content = existing ?? '{}\n'
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  for (const edit of edits) {
    content = applyEdits(content, modify(content, edit.path, edit.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    }))
  }
  return content.endsWith('\n') ? content : `${content}${eol}`
}

function workBuddyModels(current: JsonConfig): JsonObject[] {
  const models = Array.isArray(current) ? current : current.models ?? []
  if (!Array.isArray(models)) configError('models 必须是数组')
  const ids = new Set<string>()
  return models.map((entry) => {
    const record = object(entry, 'models 条目')
    if (typeof record.id !== 'string' || !record.id.trim() || ids.has(record.id)) configError('models 包含无效或重复的 ID')
    ids.add(record.id)
    return record
  })
}

function workBuddyEdits(current: JsonConfig, options: ReturnType<typeof normalizedOptions>): ConfigEdit[] {
  const records = workBuddyModels(current)
  const available = Array.isArray(current) ? undefined : stringArray(current.availableModels, 'availableModels')
  const existingIndex = records.findIndex((entry) => entry.id === options.model)
  const previous = existingIndex < 0 ? {} : records[existingIndex]
  const model = {
    ...previous,
    id: options.model,
    name: previous.name ?? options.model,
    vendor: previous.vendor ?? 'Custom',
    url: `${options.baseUrl}/chat/completions`,
    supportsToolCall: previous.supportsToolCall ?? true,
    supportsImages: previous.supportsImages ?? false,
    supportsReasoning: previous.supportsReasoning ?? false,
    useCustomProtocol: previous.useCustomProtocol ?? false,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  }
  if (existingIndex < 0) records.push(model)
  else records[existingIndex] = model
  // WorkBuddy UI writes an array; retain the object form when a user already has one.
  const edits: ConfigEdit[] = [{ path: Array.isArray(current) ? [] : ['models'], value: records }]
  // 空列表与缺省均表示全部模型；非空白名单须允许本次选择的模型。
  if (available?.length && !available.includes(options.model)) edits.push({ path: ['availableModels'], value: [...available, options.model] })
  return edits
}

function openCodeEdits(current: JsonObject, options: ReturnType<typeof normalizedOptions>): ConfigEdit[] {
  const providers = optionalObject(current.provider, 'provider')
  const provider = optionalObject(providers.xingmang, 'provider.xingmang')
  optionalObject(provider.options, 'provider.xingmang.options')
  const models = optionalObject(provider.models, 'provider.xingmang.models')
  for (const entry of Object.values(models)) object(entry, 'provider.xingmang.models 条目')
  const model = optionalObject(models[options.model], '所选模型')
  const modelProvider = optionalObject(model.provider, '所选模型 provider')
  const modelOptions = optionalObject(model.options, '所选模型 options')
  if (provider.npm !== undefined && (typeof provider.npm !== 'string' || !provider.npm.trim())) configError('provider.xingmang.npm 必须是非空字符串')
  const npm = options.protocol === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible'
  const hasOtherModels = Object.keys(models).some((id) => id !== options.model)
  const inheritedNpm = provider.npm ?? (hasOtherModels ? undefined : npm)
  const prefix = ['provider', 'xingmang']
  const edits: ConfigEdit[] = [{ path: ['model'], value: `xingmang/${options.model}` }]
  if (current.$schema === undefined) edits.push({ path: ['$schema'], value: 'https://opencode.ai/config.json' })
  if (provider.npm === undefined && !hasOtherModels) edits.push({ path: [...prefix, 'npm'], value: npm })
  if (provider.name === undefined) edits.push({ path: [...prefix, 'name'], value: '星芒 AI' })
  edits.push({ path: [...prefix, 'options', 'baseURL'], value: options.baseUrl })
  if (options.apiKey !== undefined) edits.push({ path: [...prefix, 'options', 'apiKey'], value: options.apiKey })
  // Existing model overrides take precedence over provider connection settings.
  if (modelOptions.baseURL !== undefined) edits.push({ path: [...prefix, 'models', options.model, 'options', 'baseURL'], value: options.baseUrl })
  if (options.apiKey !== undefined && modelOptions.apiKey !== undefined) edits.push({ path: [...prefix, 'models', options.model, 'options', 'apiKey'], value: options.apiKey })
  if (model.name === undefined) edits.push({ path: [...prefix, 'models', options.model, 'name'], value: options.model })
  // SDK 可按模型覆盖；切换所选模型的协议时保留其它模型继承的 provider SDK。
  if (inheritedNpm !== npm || modelProvider.npm !== undefined) {
    edits.push({ path: [...prefix, 'models', options.model, 'provider', 'npm'], value: npm })
  }
  for (const [record, key, item, editPath, remove] of [
    [current, 'enabled_providers', 'xingmang', ['enabled_providers'], false],
    [current, 'disabled_providers', 'xingmang', ['disabled_providers'], true],
    [provider, 'whitelist', options.model, [...prefix, 'whitelist'], false],
    [provider, 'blacklist', options.model, [...prefix, 'blacklist'], true],
  ] as const) {
    const values = stringArray(record[key], key)
    if (values && (remove ? values.includes(item) : !values.includes(item))) {
      edits.push({ path: [...editPath], value: remove ? values.filter((value) => value !== item) : [...values, item] })
    }
  }
  return edits
}

/** 生成模板不触碰文件；真实写入须经过 saveExternalToolConfig 的备份事务。 */
export function createExternalToolConfig(
  tool: ExternalToolId,
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  options: ExternalToolConfigOptions = {},
): ExternalToolConfigResult {
  return { tool, path: externalToolConfigPath(tool, platform, rootsInput), content: mergeExternalToolConfig(tool, null, options), format: 'json', supportsRelay: true }
}

/** 保留未知设置；OpenCode 通过语法树局部编辑保留注释与未修改字段的格式。 */
export function mergeExternalToolConfig(
  tool: ExternalToolId,
  existing: string | null,
  options: ExternalToolConfigOptions = {},
): string {
  assertExternalToolImplemented(tool)
  const normalized = normalizedOptions(tool, options)
  const edits = tool === 'workbuddy'
    ? workBuddyEdits(parseConfig(tool, existing), normalized)
    : openCodeEdits(parseConfig(tool, existing), normalized)
  return applyConfigEdits(existing, edits)
}

function mergeObjects(base: JsonObject, override: JsonObject): JsonObject {
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const previous = base[key]
    const nested = value && typeof value === 'object' && !Array.isArray(value)
      && previous && typeof previous === 'object' && !Array.isArray(previous)
    Object.defineProperty(merged, key, { value: nested ? mergeObjects(previous as JsonObject, value as JsonObject) : value, enumerable: true, configurable: true, writable: true })
  }
  return merged
}

/**
 * 连接自检要用客户端自己配置里那把密钥发一次请求，而对外的结论里永远不带它。
 * 所以内部多算一层：inspectExternalTool 连密钥一起给出来，
 * inspectExternalToolConnection 把它剥掉再跨 IPC（I3，同 toNativeConfigSummary）。
 * 只有确认归属当前账号（configured）的那一条才给密钥。
 */
interface ExternalToolInspection extends ExternalClientConnectionStatus {
  apiKey: string | null
}

export interface ExternalToolProbeCredential {
  apiKey: string
  model: string
}

/** Read only the effective global configuration; never return its key or URL. */
export function inspectExternalToolConnection(
  tool: 'workbuddy' | 'opencode',
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  expectedBaseUrl: string,
  belongsToCurrentAccount?: (apiKey: string) => boolean,
): ExternalClientConnectionStatus {
  const { apiKey: _apiKey, ...status } = inspectExternalTool(tool, platform, rootsInput, expectedBaseUrl, belongsToCurrentAccount)
  return status
}

/**
 * 主进程内部专用：把已经确认属于当前账号的那条配置连同密钥交出来，供连接自检
 * 发一次最小请求。**永不跨 IPC**。
 */
export function resolveExternalToolProbeCredential(
  tool: 'workbuddy' | 'opencode',
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  expectedBaseUrl: string,
  belongsToCurrentAccount?: (apiKey: string) => boolean,
): ExternalToolProbeCredential | null {
  const result = inspectExternalTool(tool, platform, rootsInput, expectedBaseUrl, belongsToCurrentAccount)
  return result.configured && result.apiKey && result.model ? { apiKey: result.apiKey, model: result.model } : null
}

function inspectExternalTool(
  tool: 'workbuddy' | 'opencode',
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  expectedBaseUrl: string,
  belongsToCurrentAccount?: (apiKey: string) => boolean,
): ExternalToolInspection {
  const missing: ExternalToolInspection = { configured: false, model: null, configurationSource: 'missing', configurationError: null, apiKey: null }
  try {
    const defaultPath = externalToolConfigPath(tool, platform, rootsInput)
    const endpoint = expectedBaseUrl.replace(/\/+$/, '')
    const isKey = (value: unknown) => typeof value === 'string' && Boolean(value.trim()) && !/^\{(?:env|file):/.test(value)
    if (tool === 'workbuddy') {
      const content = readSafeUtf8FileSync(defaultPath, '外部客户端配置', MAX_EXTERNAL_CONFIG_BYTES)
      if (content === null) return missing
      const current = parseConfig(tool, content)
      const allowed = Array.isArray(current) ? undefined : stringArray(current.availableModels, 'availableModels')
      const models = workBuddyModels(current)
      const selected = models.find((entry) => (!allowed?.length || allowed.includes(String(entry.id))) && isKey(entry.apiKey)
        && typeof entry.url === 'string' && entry.url.replace(/\/+$/, '') === `${endpoint}/chat/completions`
        && (!belongsToCurrentAccount || belongsToCurrentAccount(entry.apiKey as string)))
      return selected ? { ...missing, configured: true, model: String(selected.id), configurationSource: 'xingmang', apiKey: String(selected.apiKey) }
        : { ...missing, model: models.length ? String(models[0].id) : null, configurationSource: models.length ? 'other' : 'missing' }
    }
    const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => path.join(path.dirname(defaultPath), name))
    let current: JsonObject = {}
    let exists = false
    for (const file of files) {
      const content = readSafeUtf8FileSync(file, '外部客户端配置', MAX_EXTERNAL_CONFIG_BYTES)
      if (content !== null) { exists = true; current = mergeObjects(current, parseConfig(tool, content)) }
    }
    if (!exists) return missing
    if (typeof current.model !== 'string' || !current.model) return missing
    const model = current.model.startsWith('xingmang/') ? current.model.slice('xingmang/'.length) : null
    if (!model) return { ...missing, configurationSource: 'other' }
    const provider = optionalObject(optionalObject(current.provider, 'provider').xingmang, '星芒 provider')
    const models = optionalObject(provider.models, 'models')
    if (models[model] === undefined) return { ...missing, configurationSource: 'other' }
    const selected = optionalObject(models[model], '所选模型')
    const options = { ...optionalObject(provider.options, 'provider options'), ...optionalObject(selected.options, 'model options') }
    const enabled = stringArray(current.enabled_providers, 'enabled_providers')
    const disabled = stringArray(current.disabled_providers, 'disabled_providers')
    const whitelist = stringArray(provider.whitelist, 'whitelist')
    const blacklist = stringArray(provider.blacklist, 'blacklist')
    const allowed = (!enabled || enabled.includes('xingmang')) && !disabled?.includes('xingmang')
      && (!whitelist || whitelist.includes(model)) && !blacklist?.includes(model)
    const ready = allowed && isKey(options.apiKey) && typeof options.baseURL === 'string' && options.baseURL.replace(/\/+$/, '') === endpoint
      && (!belongsToCurrentAccount || belongsToCurrentAccount(options.apiKey as string))
    return { ...missing, configured: ready, model, configurationSource: ready ? 'xingmang' : 'other',
      ...(ready ? { apiKey: String(options.apiKey) } : {}) }
  } catch {
    return { ...missing, configurationSource: 'unknown', configurationError: '客户端配置无法安全读取，请检查文件格式或权限后重新检测。' }
  }
}

/**
 * 在备份事务中写入有效的全局配置。OpenCode 合并 config.json → json → jsonc；
 * 写入最高优先级的现有文件，避免被另一个全局文件覆盖。项目/环境变量配置仍可覆盖全局。
 */
export async function saveExternalToolConfig(
  tool: ExternalToolId,
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  options: ExternalToolConfigOptions = {},
  hooks: NativeConfigWriteHooks = {},
): Promise<ExternalToolConfigSaveResult> {
  assertExternalToolImplemented(tool)
  const normalized = normalizedOptions(tool, options)
  const defaultPath = externalToolConfigPath(tool, platform, rootsInput)
  const configRoot = path.dirname(defaultPath)
  const candidates = tool === 'opencode'
    ? ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => path.join(configRoot, name))
    : [defaultPath]
  const snapshots = candidates.map((filePath) => ({ path: filePath, content: readSafeUtf8FileSync(filePath, '外部客户端配置', MAX_EXTERNAL_CONFIG_BYTES) }))
  const target = [...snapshots].reverse().find((snapshot) => snapshot.content !== null)
    ?? { path: defaultPath, content: null }
  let content: string
  if (tool === 'workbuddy') {
    content = mergeExternalToolConfig(tool, target.content, options)
  } else {
    let current: JsonObject = {}
    for (const snapshot of snapshots) {
      if (snapshot.content !== null) current = mergeObjects(current, parseConfig(tool, snapshot.content))
    }
    content = applyConfigEdits(target.content, openCodeEdits(current, normalized))
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_EXTERNAL_CONFIG_BYTES) configError('合并结果超过 2 MB 安全上限')
  // 所有格式校验均先于目录创建及事务，拒绝配置时不产生文件副作用。
  ensureSafeDataDirectory(configRoot, '外部客户端配置目录')
  const saved = executeFilePlans([{ path: target.path, content }], {
    beforeReplace(filePath, index) {
      hooks.beforeReplace?.(filePath, index)
      for (const snapshot of snapshots) {
        if (readSafeUtf8FileSync(snapshot.path, '外部客户端配置', MAX_EXTERNAL_CONFIG_BYTES) !== snapshot.content) {
          throw new Error('外部客户端配置在保存前已变化，未执行修改，请重试')
        }
      }
    },
  }, configRoot)
  return { path: target.path, ...saved, supportsRelay: true }
}
