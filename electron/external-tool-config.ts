import path from 'node:path'
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { executeFilePlans, type NativeConfigWriteHooks } from './config-files'
import { ensureSafeDataDirectory, localPathPresentSync, readSafeUtf8FileSync } from './safe-local-data'
import type { ExternalClientConnectionStatus } from './external-client-contract'
import { relayRouteSiteIds, relaySiteKnownOrigins } from './relay-sites'

/** 外部客户端不属于四个 CLI Provider，凭据由服务层解析后传入。 */
export type ExternalToolId = 'workbuddy' | 'claudeDesktop' | 'opencode'
export type ExternalToolPlatform = 'win32' | 'darwin' | 'linux'

/**
 * WorkBuddy 分国内版和海外版（WorkBuddy AI），程序名、应用名、配置文件夹都不一样（2026-11-18 拆两版官方安装包核实：
 * product.json 的 dataFolderName 分别是 .workbuddy、.workbuddy-ai）。装着哪一版就写哪一版自己的 models.json。
 */
export type WorkBuddyEdition = 'domestic' | 'overseas'
export const workBuddyEditionIds: readonly WorkBuddyEdition[] = ['domestic', 'overseas']
const workBuddyDataFolders: Record<WorkBuddyEdition, string> = { domestic: '.workbuddy', overseas: '.workbuddy-ai' }

export interface ExternalToolPathRoots {
  userHome: string
  appData?: string
  configHome?: string
  /**
   * OpenCode 放登录凭据（auth.json）的那一层，对应 XDG_DATA_HOME。只用来认「从没配置过」（决定单 D7），
   * 星芒不读也不写里面的东西。缺省 = 用户目录下的 .local/share，同 OpenCode 自己的默认。
   */
  dataHome?: string
  /**
   * 这台电脑上装着的 WorkBuddy 是哪几版，每版各一份 models.json：读的时候几份一起看，写的时候每份都写。
   * 缺省或空 = 只看国内版那一份（旧行为）。
   */
  workBuddyEditions?: readonly WorkBuddyEdition[]
}

export interface ExternalToolConfigOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  protocol?: 'responses' | 'chat-completions'
  /**
   * 星芒替客户自动连的那一次（决定单 D7）：WorkBuddy 的 models.json 里已经有指向星芒的模型、或者有跟这次型号同名的
   * 模型，就一个字不写。按型号名写会把客户自己那条同名的地址和密钥换掉，自动写的时候不能冒这个险。缺省 = 客户自己
   * 点保存（旧行为：同名的那条换成星芒的）。
   */
  automatic?: boolean
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
/** append：往 path 那个数组末尾加一项，别的项一个字节不动（自动连 WorkBuddy 那一次，见 workBuddyEdits）。 */
type ConfigEdit = { path: (string | number)[]; value: unknown; append?: boolean }

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
  if (tool === 'workbuddy') return pathApi.join(userHome, workBuddyDataFolders[workBuddyEditionsOf(input)[0]], 'models.json')
  return pathApi.join(input.configHome ? pathApi.resolve(input.configHome) : pathApi.join(userHome, '.config'), 'opencode', 'opencode.json')
}

/** 要看、要写的是哪几版 WorkBuddy 的配置：去重，国内版在前；没说就是只有国内版（旧行为）。 */
function workBuddyEditionsOf(input: ExternalToolPathRoots): WorkBuddyEdition[] {
  const listed = input.workBuddyEditions ?? []
  const editions = workBuddyEditionIds.filter((edition) => listed.includes(edition))
  return editions.length ? editions : ['domestic']
}

/** 每版 WorkBuddy 各自一份 roots：下面那几个只会处理一份 models.json 的函数，按版本逐个叫。 */
function workBuddyEditionRoots(input: ExternalToolPathRoots): ExternalToolPathRoots[] {
  return workBuddyEditionsOf(input).map((edition) => ({ ...input, workBuddyEditions: [edition] }))
}

/**
 * 星芒两个站、每条线路（含退下来的别名）的地址：WorkBuddy 的一条模型指着其中任何一个，就算「接过星芒」，不管是
 * 哪个账号、哪条线路写的。只认地址的 origin，路径怎么写都一样。
 */
function pointsAtRelay(url: unknown): boolean {
  if (typeof url !== 'string') return false
  let origin: string
  try { origin = new URL(url).origin } catch { return false }
  return relayRouteSiteIds.some((siteId) => relaySiteKnownOrigins(siteId).includes(origin))
}

/**
 * OpenCode 记登录凭据的文件：客户在它里面接过别家（/connect、opencode auth login）就会有。Windows 上按跟配置
 * 目录同一套规则取用户目录的 .local/share（推断，还没真机核过，见 docs/EXTERNAL-CLIENT-CONFIG.md 的 OpenCode 一节）。
 * 推错了的话，Windows 上只在 OpenCode 里登过别家、没写过全局配置的客户会被当成从没配置过，默认型号换成星芒的。
 */
export function openCodeAuthPath(input: ExternalToolPathRoots): string {
  return path.join(input.dataHome ? path.resolve(input.dataHome) : path.join(path.resolve(input.userHome), '.local', 'share'), 'opencode', 'auth.json')
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

function applyConfigEdits(existing: string | null, edits: ConfigEdit[], keepEnding = false): string {
  let content = existing ?? '{}\n'
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  for (const edit of edits) {
    // 插一项不带排版选项：带上的话 jsonc-parser 会把整个数组重排一遍，客户的条目就不是原样了。插进去的那一条是一行紧凑 JSON。
    content = applyEdits(content, edit.append
      ? modify(content, [...edit.path, -1], edit.value, { isArrayInsertion: true })
      : modify(content, edit.path, edit.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }))
  }
  return keepEnding || content.endsWith('\n') ? content : `${content}${eol}`
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

/** inFile：current 读自一份已经在的文件（没有文件时是凭空给的空列表，没有可以往里插的那个数组）。 */
function workBuddyEdits(current: JsonConfig, options: ReturnType<typeof normalizedOptions>, automatic = false, inFile = true): ConfigEdit[] {
  const records = workBuddyModels(current)
  // 自动连的那一次只往一份还没接过星芒的 models.json 里加一条新的：客户自己加的模型一条都不碰（同名也不碰）。
  if (automatic && records.some((entry) => entry.id === options.model || pointsAtRelay(entry.url))) configError('里已经有星芒的模型或同名的模型，这次没有自动连接')
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
  const listPath = Array.isArray(current) ? [] : ['models']
  // 自动连那一次（上面已确认没有同名、没有星芒的）只在列表末尾插这一条：客户自己的条目连格式带顺序一个字节不动。
  // 还没有这份文件、或文件里还没有模型列表时整个写一份新的。
  const appended = automatic && inFile && (Array.isArray(current) || Array.isArray(current.models))
  if (existingIndex < 0) records.push(model)
  else records[existingIndex] = model
  // WorkBuddy UI writes an array; retain the object form when a user already has one.
  const edits: ConfigEdit[] = [appended ? { path: listPath, value: model, append: true } : { path: listPath, value: records }]
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
    ? workBuddyEdits(parseConfig(tool, existing), normalized, options.automatic === true, existing !== null)
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
  /** 只有 Claude Desktop 有：它开机检查挑的那个型号（claude-desktop-models.ts），可能不是默认的 model。 */
  startupCheckModel?: string
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
  // 两版 WorkBuddy 都装着时，哪一份是星芒替这个账号写的就交哪一份（国内版在前）。
  for (const roots of tool === 'workbuddy' ? workBuddyEditionRoots(rootsInput) : [rootsInput]) {
    const result = inspectExternalToolFile(tool, platform, roots, expectedBaseUrl, belongsToCurrentAccount)
    if (result.configured && result.apiKey && result.model) return { apiKey: result.apiKey, model: result.model }
  }
  return null
}

/**
 * 两版 WorkBuddy 都装着时，首页那一行按两份合起来说：两份都是星芒替当前账号写的才算连好；有一份读不了就照那份说；
 * 有一份里是别的（别的账号、别的线路，或者只有客户自己的模型）就是 other，好让换线路、换 Key 那边照旧去找；
 * 剩下的（一份连好、一份还没接）是 missing，首页照旧「待连接」，点「确认连接」两份一起写。两份都没接过星芒
 * 才算 pristine（D7）。
 */
export function combineWorkBuddyInspections<T extends ExternalClientConnectionStatus>(results: readonly T[]): T | ExternalClientConnectionStatus {
  if (results.length === 1) return results[0]
  const broken = results.find((result) => result.configurationSource === 'unknown')
  if (broken) return broken
  if (results.length && results.every((result) => result.configured)) return results[0]
  const shown = results.find((result) => result.configured) ?? results.find((result) => result.configurationSource === 'other') ?? results[0]
  return {
    configured: false, model: shown?.model ?? null, configurationError: null,
    configurationSource: results.some((result) => result.configurationSource === 'other') ? 'other' : 'missing',
    ...(results.length && results.every((result) => result.pristine === true) ? { pristine: true } : {}),
  }
}

function inspectExternalTool(
  tool: 'workbuddy' | 'opencode',
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  expectedBaseUrl: string,
  belongsToCurrentAccount?: (apiKey: string) => boolean,
): ExternalToolInspection {
  if (tool !== 'workbuddy') return inspectExternalToolFile(tool, platform, rootsInput, expectedBaseUrl, belongsToCurrentAccount)
  const results = workBuddyEditionRoots(rootsInput).map((roots) => inspectExternalToolFile(tool, platform, roots, expectedBaseUrl, belongsToCurrentAccount))
  const combined = combineWorkBuddyInspections(results)
  return 'apiKey' in combined ? combined : { ...combined, apiKey: null }
}

function inspectExternalToolFile(
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
      if (content === null) return { ...missing, pristine: true }
      const current = parseConfig(tool, content)
      const allowed = Array.isArray(current) ? undefined : stringArray(current.availableModels, 'availableModels')
      const models = workBuddyModels(current)
      const selected = models.find((entry) => (!allowed?.length || allowed.includes(String(entry.id))) && isKey(entry.apiKey)
        && typeof entry.url === 'string' && entry.url.replace(/\/+$/, '') === `${endpoint}/chat/completions`
        && (!belongsToCurrentAccount || belongsToCurrentAccount(entry.apiKey as string)))
      // 一条指着星芒的模型都没有才算没接过星芒（D7，2026-11-18 起）：客户自己加的别家模型不算，WorkBuddy 自己建的
      // 空 models.json 也不算。客户删过星芒那条的，由服务层看归属记录挡掉（星芒替这个账号写过就不再自动写）。
      const fresh = models.some((entry) => pointsAtRelay(entry.url)) ? {} : { pristine: true }
      return selected ? { ...missing, configured: true, model: String(selected.id), configurationSource: 'xingmang', apiKey: String(selected.apiKey) }
        : { ...missing, model: models.length ? String(models[0].id) : null, configurationSource: models.length ? 'other' : 'missing', ...fresh }
    }
    const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => path.join(path.dirname(defaultPath), name))
    let current: JsonObject = {}
    let exists = false
    for (const file of files) {
      const content = readSafeUtf8FileSync(file, '外部客户端配置', MAX_EXTERNAL_CONFIG_BYTES)
      if (content !== null) { exists = true; current = mergeObjects(current, parseConfig(tool, content)) }
    }
    // 全局配置一个都没有、也没在 OpenCode 里登过别家（它把登录凭据放在 auth.json），才算从没配置过（D7）。
    // 配置文件在、只是没写默认型号的不算：客户可能靠 auth.json 里的别家在用，写进星芒的默认型号就换掉了他的。
    if (!exists) return localPathPresentSync(openCodeAuthPath(rootsInput)) ? missing : { ...missing, pristine: true }
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
  if (tool === 'workbuddy') {
    // 每版 WorkBuddy 一份 models.json，先把每份要写成什么都算好（自动连时哪一份不该写就整笔不写），再一份一份提交。
    // 两份分属两个程序，各自是一次完整的备份事务；后一份没写成时前一份已经是能用的完整配置，不会留下半份。
    const plans = workBuddyEditionRoots(rootsInput).map((roots) => {
      const files = readExternalToolFiles(tool, platform, roots)
      return { files, content: mergeExternalToolConfig(tool, files.target.content, options) }
    })
    return combinedSaveResult(plans.map(({ files, content }) => commitExternalToolFiles(files, [{ path: files.target.path, content }], hooks)))
  }
  const files = readExternalToolFiles(tool, platform, rootsInput)
  const content = applyConfigEdits(files.target.content, openCodeEdits(mergedOpenCodeConfig(files.snapshots), normalized))
  return commitExternalToolFiles(files, [{ path: files.target.path, content }], hooks)
}

/** 几份 models.json 各自提交完：路径报第一份（国内版在前），备份和写过的文件都列上。 */
function combinedSaveResult(results: readonly ExternalToolConfigSaveResult[]): ExternalToolConfigSaveResult {
  return { path: results[0].path, backups: results.flatMap((result) => result.backups), files: results.flatMap((result) => result.files), supportsRelay: true }
}

/**
 * 换线路（第四十三批 A）：只把星芒替当前账号写的那几处地址从 from 换成 to，别的一个字不动，
 * 连文件末尾有没有换行都照旧。WorkBuddy 是地址为 from、Key 是这一把的每一条（星芒每存一个型号
 * 多一条，只换一条的话客户正在用的那条可能还留在旧线路上）；OpenCode 是星芒那一段里当前型号
 * 生效的地址，provider 和这个型号自己覆盖的那一处都换，改的是定义它的那个文件，不往客户别的
 * 文件里加字段；npm 包（协议）、型号都不碰。写之前在这次读出来的内容上再认一遍，已经对不上
 * （客户刚改过）就一个字不写。
 */
export async function followExternalToolRoute(
  tool: ExternalToolId,
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  route: { from: string; to: string; apiKey: string },
  hooks: NativeConfigWriteHooks = {},
): Promise<ExternalToolConfigSaveResult> {
  assertExternalToolImplemented(tool)
  const { baseUrl: to, apiKey } = normalizedOptions(tool, { baseUrl: route.to, apiKey: route.apiKey })
  const from = route.from.replace(/\/+$/, '')
  if (tool === 'workbuddy') {
    // 两版都装着时只改里面真有这几条的那一份（另一份可能已经换过、还没接过星芒，或者是别的账号的），哪份都没有才算变了。
    const plans = workBuddyEditionRoots(rootsInput).flatMap((roots) => {
      const files = readExternalToolFiles(tool, platform, roots)
      const current = parseConfig(tool, files.target.content)
      const prefix = Array.isArray(current) ? [] : ['models']
      const edits = workBuddyModels(current).flatMap((record, index): ConfigEdit[] => typeof record.url === 'string'
        && record.url.replace(/\/+$/, '') === `${from}/chat/completions` && record.apiKey === apiKey
        ? [{ path: [...prefix, index, 'url'], value: `${to}/chat/completions` }] : [])
      return edits.length ? [{ files, content: applyConfigEdits(files.target.content, edits, true) }] : []
    })
    if (!plans.length) configError('在换线路前已变化')
    return combinedSaveResult(plans.map(({ files, content }) => commitExternalToolFiles(files, [{ path: files.target.path, content }], hooks)))
  }
  const files = readExternalToolFiles(tool, platform, rootsInput)
  return commitExternalToolFiles(files, openCodeFieldPlans(files, { baseUrl: from, apiKey }, 'baseURL', to, '换线路'), hooks)
}

/** 换 Key 的结论（主进程内部用，不跨 IPC）：unsupportedModels 是新 Key 不认、所以这次没换的 WorkBuddy 条目的型号。 */
export interface ExternalToolKeyFollowResult extends ExternalToolConfigSaveResult {
  unsupportedModels: string[]
}

/**
 * 换 Key（#1113）：星芒替某个工具换了 Key，借它那把的 WorkBuddy、OpenCode 跟着换，只把星芒替当前账号写的
 * 那几处 Key 从 from 换成 to，地址、型号、协议都不动，规矩同 followExternalToolRoute。WorkBuddy 是地址为
 * baseUrl、Key 是 from、型号在 offered（新 Key 能用的型号）里的每一条：WorkBuddy 每条各带各的 Key，新 Key 不认的
 * 那条换过去也发不通，原样留着，一条都不认就整笔不写。OpenCode 是星芒那一段里当前型号生效的 Key，当前型号由
 * 调用方核过。
 */
export async function followExternalToolKey(
  tool: ExternalToolId,
  platform: ExternalToolPlatform,
  rootsInput: ExternalToolPathRoots,
  change: { baseUrl: string; from: string; to: string; offered: readonly string[] },
  hooks: NativeConfigWriteHooks = {},
): Promise<ExternalToolKeyFollowResult> {
  assertExternalToolImplemented(tool)
  const { baseUrl, apiKey: to } = normalizedOptions(tool, { baseUrl: change.baseUrl, apiKey: change.to })
  if (!to) configError('API Key无效')
  if (tool === 'workbuddy') {
    // 同换线路：两版都装着时只改里面真有这把的那一份。
    const found = workBuddyEditionRoots(rootsInput).map((roots) => {
      const files = readExternalToolFiles(tool, platform, roots)
      const current = parseConfig(tool, files.target.content)
      const prefix = Array.isArray(current) ? [] : ['models']
      const owned = workBuddyModels(current).flatMap((record, index) => typeof record.url === 'string'
        && record.url.replace(/\/+$/, '') === `${baseUrl}/chat/completions` && record.apiKey === change.from
        ? [{ model: String(record.id), index }] : [])
      const edits = owned.flatMap(({ model, index }): ConfigEdit[] => change.offered.includes(model) ? [{ path: [...prefix, index, 'apiKey'], value: to }] : [])
      return { files, owned, edits }
    })
    if (!found.some(({ owned }) => owned.length)) configError('在换密钥前已变化')
    const plans = found.filter(({ edits }) => edits.length)
    if (!plans.length) configError('里的型号新密钥都不支持')
    const saved = combinedSaveResult(plans.map(({ files, edits }) => commitExternalToolFiles(files, [{ path: files.target.path, content: applyConfigEdits(files.target.content, edits, true) }], hooks)))
    const unsupported = found.flatMap(({ owned }) => owned.filter(({ model }) => !change.offered.includes(model)).map(({ model }) => model))
    return { ...saved, unsupportedModels: [...new Set(unsupported)] }
  }
  const files = readExternalToolFiles(tool, platform, rootsInput)
  return { ...commitExternalToolFiles(files, openCodeFieldPlans(files, { baseUrl, apiKey: change.from }, 'apiKey', to, '换密钥'), hooks), unsupportedModels: [] }
}

/**
 * OpenCode 星芒那一段里当前型号生效的 field 换成 value：provider 和这个型号自己覆盖的那一处，是 expected 里那个值的
 * 都换，改的是最后定义它的那个文件，不往客户别的文件里加字段。生效的地址和 Key 已经不是 expected（客户刚改过）
 * 就一个字不写。
 */
function openCodeFieldPlans(
  files: ReturnType<typeof readExternalToolFiles>,
  expected: { baseUrl: string; apiKey: string | undefined },
  field: 'baseURL' | 'apiKey',
  value: string,
  action: string,
): { path: string; content: string }[] {
  const current = mergedOpenCodeConfig(files.snapshots)
  const model = typeof current.model === 'string' && current.model.startsWith('xingmang/') ? current.model.slice('xingmang/'.length) : null
  const provider = optionalObject(optionalObject(current.provider, 'provider').xingmang, '星芒 provider')
  const models = optionalObject(provider.models, 'models')
  if (!model || models[model] === undefined) configError(`在${action}前已变化`)
  const providerOptions = optionalObject(provider.options, 'provider options')
  const modelOptions = optionalObject(optionalObject(models[model], '所选模型').options, 'model options')
  const effective = { ...providerOptions, ...modelOptions }
  const atBase = (entry: unknown) => typeof entry === 'string' && entry.replace(/\/+$/, '') === expected.baseUrl
  if (!atBase(effective.baseURL) || effective.apiKey !== expected.apiKey) configError(`在${action}前已变化`)
  const owned = field === 'baseURL' ? atBase : (entry: unknown) => entry === expected.apiKey
  // 几个文件按顺序合并，后面的盖前面的：哪一处生效，就改最后定义它的那个文件。
  const parsed = files.snapshots.map((snapshot) => snapshot.content === null ? null : parseConfig('opencode', snapshot.content))
  const edits = new Map<number, ConfigEdit[]>()
  for (const [keys, entry] of [[['options', field], providerOptions[field]], [['models', model, 'options', field], modelOptions[field]]] as const) {
    if (!owned(entry)) continue
    const editPath = ['provider', 'xingmang', ...keys]
    let index = parsed.length - 1
    while (index >= 0 && valueAt(parsed[index], editPath) === undefined) index--
    if (index < 0) configError(`在${action}前已变化`)
    edits.set(index, [...edits.get(index) ?? [], { path: editPath, value }])
  }
  return [...edits].sort(([left], [right]) => left - right).map(([index, fileEdits]) => ({
    path: files.snapshots[index].path, content: applyConfigEdits(files.snapshots[index].content, fileEdits, true),
  }))
}

/** 合并前单个文件里这一路径上的值；中间哪一层不是对象就当没写。 */
function valueAt(config: JsonObject | null, keys: readonly string[]): unknown {
  let value: unknown = config
  for (const key of keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as JsonObject)[key]
  }
  return value
}

/** OpenCode 按 config.json → opencode.json → opencode.jsonc 读，写进最高优先级的现有文件；WorkBuddy 只有一个文件。 */
function readExternalToolFiles(tool: 'workbuddy' | 'opencode', platform: ExternalToolPlatform, rootsInput: ExternalToolPathRoots) {
  const defaultPath = externalToolConfigPath(tool, platform, rootsInput)
  const configRoot = path.dirname(defaultPath)
  const candidates = tool === 'opencode'
    ? ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => path.join(configRoot, name))
    : [defaultPath]
  const snapshots = candidates.map((filePath) => ({ path: filePath, content: readSafeUtf8FileSync(filePath, '外部客户端配置', MAX_EXTERNAL_CONFIG_BYTES) }))
  const target = [...snapshots].reverse().find((snapshot) => snapshot.content !== null)
    ?? { path: defaultPath, content: null }
  return { configRoot, snapshots, target }
}

function mergedOpenCodeConfig(snapshots: readonly { content: string | null }[]): JsonObject {
  let current: JsonObject = {}
  for (const snapshot of snapshots) {
    if (snapshot.content !== null) current = mergeObjects(current, parseConfig('opencode', snapshot.content))
  }
  return current
}

function commitExternalToolFiles(
  files: ReturnType<typeof readExternalToolFiles>,
  plans: { path: string; content: string }[],
  hooks: NativeConfigWriteHooks,
): ExternalToolConfigSaveResult {
  for (const plan of plans) if (Buffer.byteLength(plan.content, 'utf8') > MAX_EXTERNAL_CONFIG_BYTES) configError('合并结果超过 2 MB 安全上限')
  // 所有格式校验均先于目录创建及事务，拒绝配置时不产生文件副作用。
  ensureSafeDataDirectory(files.configRoot, '外部客户端配置目录')
  const saved = executeFilePlans(plans, {
    beforeReplace(filePath, index) {
      hooks.beforeReplace?.(filePath, index)
      // 一次改两个文件时，排在前面的那个已经换成了这次写的内容，拿它比，不拿读出来时的。
      const written = new Map(plans.slice(0, index).map((plan) => [plan.path, plan.content]))
      for (const snapshot of files.snapshots) {
        const expected = written.has(snapshot.path) ? written.get(snapshot.path) : snapshot.content
        if (readSafeUtf8FileSync(snapshot.path, '外部客户端配置', MAX_EXTERNAL_CONFIG_BYTES) !== expected) {
          throw new Error('外部客户端配置在保存前已变化，未执行修改，请重试')
        }
      }
    },
  }, files.configRoot)
  return { path: plans[plans.length - 1].path, ...saved, supportsRelay: true }
}
