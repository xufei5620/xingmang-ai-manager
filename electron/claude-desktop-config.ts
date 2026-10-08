import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { readSafeUtf8FileSync } from './safe-local-data'
import { commitClaudeDesktopFiles } from './claude-desktop-local-transaction'
import type { ExternalClientConnectionStatus } from './external-client-contract'

const label = 'Claude Desktop 第三方推理配置'
const maximumBytes = 512 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type JsonObject = Record<string, unknown>

/** Main-process input: never return this object through renderer IPC. */
export interface ClaudeDesktopGatewayInput {
  baseUrl: string
  apiKey: string
  authScheme?: 'bearer' | 'x-api-key'
  models?: readonly string[]
}

export interface ClaudeDesktopConfigResult {
  path: string
  files: string[]
  backups: string[]
  mode: 'local'
  supportsRelay: true
  restartRequired: true
  connectionVerified: false
  warnings: string[]
}

/**
 * 开机修复星芒自己那份配置的结论。unrecognized 是「星芒写过、清单也不止一个型号，但认不准
 * 是 0.2.12 那个写法」：没动，reason 只进运行日志。
 */
export type ClaudeDesktopModelRepairOutcome =
  | { status: 'unowned' | 'unchanged' }
  | { status: 'unrecognized'; reason: 'unreadable' | 'model-list' | 'gateway' }
  | { status: 'repaired'; model: string; backups: string[] }

export interface ClaudeDesktopConfigOptions {
  dataDirectory: string
  profileDirectory: string
  developerDirectories?: readonly string[]
  assertBeforeWrite?: () => void
  assertUnmanaged?: () => Promise<void>
}

interface LibraryEntry extends JsonObject { id: string; name: string }
interface LibraryMetadata extends JsonObject { entries: LibraryEntry[]; appliedId?: string | null }
interface OwnedProfile { version: 1; profileDirectory: string; id: string }

function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function field(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}的${name}无效`)
  }
  return value.trim()
}

/** Full gateway base URL is preserved; never append a guessed /v1 suffix. */
export function buildClaudeDesktopGatewayConfig(input: ClaudeDesktopGatewayInput): Record<string, string | string[]> {
  const baseUrl = field(input.baseUrl, '网关地址')
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { throw new Error(`${label}的网关地址无效`) }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error(`${label}需要 HTTPS 地址（本机回环地址可使用 HTTP），且不能包含凭据、查询参数或片段`)
  }
  const apiKey = field(input.apiKey, 'API Key', 16384)
  const authScheme = input.authScheme ?? 'bearer'
  if (authScheme !== 'bearer' && authScheme !== 'x-api-key') throw new Error(`${label}的鉴权方式无效`)
  if (input.models !== undefined && (!Array.isArray(input.models) || input.models.length > 100)) throw new Error(`${label}的模型列表无效`)
  const models = input.models?.map((model) => field(model, '模型 ID', 512))
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: apiKey,
    inferenceGatewayAuthScheme: authScheme,
    inferenceCredentialKind: 'static',
    ...(models?.length ? { inferenceModels: [...new Set(models)] } : {}),
  }
}

// 0.2.12 的写法（#685 起，#746 撤回；0.2.11 没发给客户）：选中的型号排第一，后面跟当前 Key
// 能用的其余 claude-* 型号，去重后按 localeCompare 排好，一共最多 20 个。
const legacyMaximumModels = 20

/**
 * 型号清单逐项都对得上 0.2.12 写出来的样子时，回当时选中的那一个（清单第一项）；对不上
 * 就回 null。客户在 Claude Desktop 自己的设置窗口里改过的清单（对象写法、顺序变了、混进
 * 别家型号、多出空格）都对不上，开机修复据此不碰。排序用和当年同一个比较函数：同一台
 * 电脑上同一个比较结果，纯小写的型号名在各语言环境下也一样。
 */
export function legacyClaudeDesktopSelectedModel(models: unknown): string | null {
  if (!Array.isArray(models) || models.length < 2 || models.length > legacyMaximumModels) return null
  const ids: string[] = []
  for (const model of models) {
    if (typeof model !== 'string' || !model || model !== model.trim() || model.length > 512 || /[\x00-\x1f\x7f]/.test(model)) return null
    ids.push(model)
  }
  const [selected, ...others] = ids
  if (new Set(ids).size !== ids.length || !others.every((model) => /^claude-/i.test(model))) return null
  return others.every((model, index) => index === 0 || others[index - 1].localeCompare(model) <= 0) ? selected : null
}

function sameBaseUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象`)
  return value as JsonObject
}

function assertUniqueProperties(node: Node, depth = 0): void {
  if (depth > 64) throw new Error(`${label}嵌套过深`)
  if (node.type === 'object') {
    const names = new Set<string>()
    for (const property of node.children ?? []) {
      const name = property.children?.[0]?.value as string
      if (names.has(name)) throw new Error(`${label}包含重复字段`)
      names.add(name)
    }
  }
  for (const child of node.children ?? []) assertUniqueProperties(child, depth + 1)
}

function parseObject(content: string | null): JsonObject {
  if (content === null) return {}
  const errors: ParseError[] = []
  const tree = parseTree(content, errors, { allowTrailingComma: false, disallowComments: true })
  if (!tree || errors.length) throw new Error(`${label}无法解析为有效 JSON，未修改原文件`)
  assertUniqueProperties(tree)
  return object(getNodeValue(tree))
}

function parseMetadata(content: string | null): LibraryMetadata {
  if (content === null) return { entries: [] }
  const meta = parseObject(content)
  if (!Array.isArray(meta.entries) || meta.entries.length > 1000) throw new Error(`${label}配置库目录无效`)
  const ids = new Set<string>()
  for (const entry of meta.entries) {
    const item = object(entry)
    if (typeof item.id !== 'string' || !uuidPattern.test(item.id) || ids.has(item.id.toLowerCase())
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 512 || /[\x00-\x1f\x7f]/.test(item.name)) {
      throw new Error(`${label}配置库条目无效或重复`)
    }
    ids.add(item.id.toLowerCase())
  }
  if (meta.appliedId !== undefined && meta.appliedId !== null
    && (typeof meta.appliedId !== 'string' || !uuidPattern.test(meta.appliedId) || !ids.has(meta.appliedId.toLowerCase()))) {
    throw new Error(`${label}当前配置指针无效`)
  }
  return meta as LibraryMetadata
}

function pathIdentity(directory: string): string {
  const resolved = path.resolve(directory)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseOwner(content: string | null, profileDirectory: string): OwnedProfile | null {
  if (content === null) return null
  const marker = parseObject(content)
  if (marker.version !== 1 || marker.profileDirectory !== pathIdentity(profileDirectory)
    || typeof marker.id !== 'string' || !uuidPattern.test(marker.id)) {
    throw new Error(`${label}工具箱配置归属记录无效`)
  }
  return marker as unknown as OwnedProfile
}

function firstModel(models: unknown): string | null {
  if (!Array.isArray(models)) return null
  const first = models[0]
  const id = typeof first === 'string' ? first : first && typeof first === 'object' && !Array.isArray(first) ? (first as JsonObject).name : null
  return typeof id === 'string' && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id) ? id : null
}

function hasDynamicConfiguration(config: JsonObject): boolean {
  return Boolean(config.bootstrapUrl && config.bootstrapEnabled !== false) || Boolean(config.selfHostedUrl || config.selfHosted)
}

function gatewayConfigurationReady(config: JsonObject): boolean {
  if (config.inferenceProvider !== 'gateway' || hasDynamicConfiguration(config)
    || (config.inferenceCredentialKind !== undefined && config.inferenceCredentialKind !== 'static')
    || typeof config.inferenceGatewayBaseUrl !== 'string' || typeof config.inferenceGatewayApiKey !== 'string'
    || (config.inferenceGatewayAuthScheme !== undefined && config.inferenceGatewayAuthScheme !== 'bearer' && config.inferenceGatewayAuthScheme !== 'x-api-key')) return false
  try {
    let models: string[] | undefined
    if (config.inferenceModels !== undefined) {
      if (!Array.isArray(config.inferenceModels)) return false
      models = config.inferenceModels.map((model) => typeof model === 'string' ? model : field(object(model).name, '模型 ID', 512))
    }
    // Missing models are valid: Claude can discover the gateway's model list.
    buildClaudeDesktopGatewayConfig({
      baseUrl: config.inferenceGatewayBaseUrl, apiKey: config.inferenceGatewayApiKey,
      authScheme: config.inferenceGatewayAuthScheme, models,
    })
    return true
  } catch { return false }
}

export function createClaudeDesktopConfigService(options: ClaudeDesktopConfigOptions) {
  for (const directory of [options.dataDirectory, options.profileDirectory, ...(options.developerDirectories ?? [])]) {
    if (!path.isAbsolute(directory)) throw new Error(`${label}保存目录必须是绝对路径`)
  }
  const profileDirectory = path.resolve(options.profileDirectory)
  const libraryDirectory = path.join(profileDirectory, 'configLibrary')
  const metadataPath = path.join(libraryDirectory, '_meta.json')
  const configPath = path.join(profileDirectory, 'claude_desktop_config.json')
  const identity = pathIdentity(profileDirectory)
  const markerPath = path.join(options.dataDirectory, 'external-clients', 'claude-desktop', `${createHash('sha256').update(identity).digest('hex')}.json`)
  const developerDirectories = [...new Map([profileDirectory, ...(options.developerDirectories ?? [])].map((directory) => [pathIdentity(directory), path.resolve(directory)])).values()]
  const read = (filePath: string) => readSafeUtf8FileSync(filePath, label, maximumBytes)
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  function assertContext(): void {
    try { options.assertBeforeWrite?.() } catch { throw new Error(`${label}期间账号已切换，请重新保存`) }
  }

  /**
   * 比 inspectConnection 多一把明文网关密钥，给连接自检发一次最小请求用。
   * **永不跨 IPC**：对外的 inspectConnection 会把它剥掉（I3）。只有确认归属
   * 当前账号的那一份才给密钥。
   */
  async function inspectGateway(
    expectedBaseUrl: string,
    belongsToCurrentAccount?: (apiKey: string) => boolean,
  ): Promise<ExternalClientConnectionStatus & { apiKey: string | null }> {
    try {
      await options.assertUnmanaged?.()
      const desktop = parseObject(read(configPath))
      const metadata = parseMetadata(read(metadataPath))
      const owner = parseOwner(read(markerPath), profileDirectory)
      if (!metadata.appliedId) return { configured: false, configurationReady: false, model: null, configurationSource: 'missing', configurationError: null, apiKey: null }
      const config = parseObject(read(path.join(libraryDirectory, `${metadata.appliedId}.json`)))
      if (!Object.keys(config).length && !metadata.hybridPointer) {
        return { configured: false, configurationReady: false, model: null, configurationSource: 'missing', configurationError: null, apiKey: null }
      }
      const model = firstModel(config.inferenceModels)
      const apiKey = config.inferenceGatewayApiKey
      const baseUrl = config.inferenceGatewayBaseUrl
      const configurationReady = (desktop.deploymentMode === undefined || desktop.deploymentMode === '3p')
        && !metadata.hybridPointer && gatewayConfigurationReady(config)
      const configured = configurationReady
        && typeof baseUrl === 'string' && sameBaseUrl(baseUrl, expectedBaseUrl)
        && typeof apiKey === 'string' && Boolean(apiKey.trim())
        && (owner?.id === metadata.appliedId || Boolean(belongsToCurrentAccount))
        && (!belongsToCurrentAccount || belongsToCurrentAccount(apiKey))
      return { configured, configurationReady, model, configurationSource: configured ? 'xingmang' : 'other', configurationError: null,
        apiKey: configured && typeof apiKey === 'string' ? apiKey : null }
    } catch {
      return { configured: false, configurationReady: false, model: null, configurationSource: 'unknown', configurationError: 'Claude Desktop 本地配置无法确认，可能存在管理策略或配置文件异常，请重新检测。', apiKey: null }
    }
  }

  return {
    /**
     * 开机一次性修复（claude-desktop-model-repair.ts）：0.2.12 往星芒自己那份配置里写进了一串
     * 型号，Claude Desktop 因此发消息没有回复。这里只把 inferenceModels 改回当时选中的那一个，
     * 和 #746 之后「保存配置」写出来的一样，其余字段原样留着。不是星芒那份、清单认不准、网关
     * 地址不是星芒的，一律不动。
     *
     * 不查管理策略、不核对当前账号：只是把星芒自己写过的清单收窄，策略管着时 Claude Desktop
     * 本来就不读它，换了账号这份也照样坏着；Windows 上查策略要起 PowerShell，不值得为它在
     * 开机时多跑一个进程。
     */
    repairLegacyModelList: (relayBaseUrls: readonly string[]): Promise<ClaudeDesktopModelRepairOutcome> => serial(async () => {
      const snapshots = new Map<string, string | null>()
      const capture = (filePath: string) => {
        const content = read(filePath)
        snapshots.set(filePath, content)
        return content
      }
      // 读不出来（被占用、读到一半变了、目录联接这次不放行）往外抛，算这次没修成、下次开机
      // 再试；读出来了却解析不了，是文件本身坏了或被别人改过，认不准，不再看。
      const ownerContent = capture(markerPath)
      let owner: OwnedProfile | null
      try { owner = parseOwner(ownerContent, profileDirectory) } catch { return { status: 'unrecognized', reason: 'unreadable' } }
      if (!owner) return { status: 'unowned' }
      const gatewayPath = path.join(libraryDirectory, `${owner.id}.json`)
      const gatewayContent = capture(gatewayPath)
      if (gatewayContent === null) return { status: 'unchanged' }
      let gateway: JsonObject
      try { gateway = parseObject(gatewayContent) } catch { return { status: 'unrecognized', reason: 'unreadable' } }
      const models = gateway.inferenceModels
      if (!Array.isArray(models) || models.length < 2) return { status: 'unchanged' }
      const model = legacyClaudeDesktopSelectedModel(models)
      if (!model) return { status: 'unrecognized', reason: 'model-list' }
      const baseUrl = gateway.inferenceGatewayBaseUrl
      if (gateway.inferenceProvider !== 'gateway' || typeof baseUrl !== 'string'
        || !relayBaseUrls.some((relayBaseUrl) => sameBaseUrl(baseUrl, relayBaseUrl))) {
        return { status: 'unrecognized', reason: 'gateway' }
      }
      const content = json({ ...gateway, inferenceModels: [model] })
      if (Buffer.byteLength(content, 'utf8') > maximumBytes) throw new Error(`${label}超过文件大小上限`)
      const saved = commitClaudeDesktopFiles([{ path: gatewayPath, content }], snapshots, () => undefined)
      return { status: 'repaired', model, backups: saved.backups }
    }),
    inspectConnection: async (expectedBaseUrl: string, belongsToCurrentAccount?: (apiKey: string) => boolean): Promise<ExternalClientConnectionStatus> => {
      const { apiKey: _apiKey, ...status } = await inspectGateway(expectedBaseUrl, belongsToCurrentAccount)
      return status
    },
    /** 主进程内部专用：连接自检要用的网关密钥与模型；不属于当前账号时为 null。 */
    inspectGatewayCredential: async (
      expectedBaseUrl: string,
      belongsToCurrentAccount?: (apiKey: string) => boolean,
    ): Promise<{ apiKey: string; model: string } | null> => {
      const result = await inspectGateway(expectedBaseUrl, belongsToCurrentAccount)
      return result.configured && result.apiKey && result.model ? { apiKey: result.apiKey, model: result.model } : null
    },
    /**
     * 换线路用（第四十三批 A）：正在用的就是星芒标记的那一份时，交出它的网关地址、Key 和第一个
     * 型号（没写型号、由 Claude Desktop 自动获取时为 null），是哪条线路、归属对不对由调用方认。
     * 客户复制出来再切过去用的那份哪怕地址、Key 都一样也不认：换线路不该替他把正在用的切回
     * 星芒那份。主进程内部专用，永不跨 IPC（I3）。
     */
    inspectOwnedRoute: async (): Promise<{ baseUrl: string; apiKey: string; model: string | null } | null> => {
      try {
        await options.assertUnmanaged?.()
        const desktop = parseObject(read(configPath))
        const metadata = parseMetadata(read(metadataPath))
        const owner = parseOwner(read(markerPath), profileDirectory)
        if (!owner || metadata.appliedId !== owner.id || metadata.hybridPointer
          || (desktop.deploymentMode !== undefined && desktop.deploymentMode !== '3p')) return null
        const gateway = parseObject(read(path.join(libraryDirectory, `${owner.id}.json`)))
        const { inferenceGatewayBaseUrl: baseUrl, inferenceGatewayApiKey: apiKey } = gateway
        if (!gatewayConfigurationReady(gateway) || typeof baseUrl !== 'string' || typeof apiKey !== 'string' || !apiKey.trim()) return null
        return { baseUrl, apiKey, model: firstModel(gateway.inferenceModels) }
      } catch {
        return null
      }
    },
    /**
     * 换线路（第四十三批 A）：只把星芒那份的网关地址从 from 换成 to，文件里别的一个字不动（缩进、
     * 字段顺序照 Claude Desktop 自己写的样子）。型号清单、认证方式这些客户可能在 Claude Desktop
     * 里自己改过的字段原样留着，也不碰别的文件；不走 saveGateway，那条会把型号收成一个、认证方式
     * 改回 bearer。管理策略要起 PowerShell，先查完再调 beforeCommit（调用方在那里最后看一眼客户端
     * 开没开），之后到写完都是同步的。写之前重读一遍：已经不是星芒那份在用、地址不是 from、Key
     * 不是这一把，一个字不写。
     */
    followRoute: (from: string, to: string, apiKey: string, beforeCommit?: () => Promise<void>): Promise<{ path: string; backups: string[] }> => serial(async () => {
      assertContext()
      await options.assertUnmanaged?.()
      await beforeCommit?.()
      assertContext()
      const snapshots = new Map<string, string | null>()
      const capture = (filePath: string) => {
        const content = read(filePath)
        snapshots.set(filePath, content)
        return content
      }
      const desktop = parseObject(capture(configPath))
      const metadata = parseMetadata(capture(metadataPath))
      const owner = parseOwner(capture(markerPath), profileDirectory)
      const gatewayPath = owner ? path.join(libraryDirectory, `${owner.id}.json`) : null
      const original = gatewayPath ? capture(gatewayPath) : null
      const gateway = parseObject(original)
      if (!owner || !gatewayPath || original === null || metadata.appliedId !== owner.id || metadata.hybridPointer
        || (desktop.deploymentMode !== undefined && desktop.deploymentMode !== '3p') || !gatewayConfigurationReady(gateway)
        || typeof gateway.inferenceGatewayBaseUrl !== 'string' || !sameBaseUrl(gateway.inferenceGatewayBaseUrl, from)
        || gateway.inferenceGatewayApiKey !== apiKey) {
        throw new Error(`${label}在换线路前已变化，未执行修改`)
      }
      const { inferenceGatewayBaseUrl } = buildClaudeDesktopGatewayConfig({ baseUrl: to, apiKey })
      const content = applyEdits(original, modify(original, ['inferenceGatewayBaseUrl'], inferenceGatewayBaseUrl, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' },
      }))
      if (Buffer.byteLength(content, 'utf8') > maximumBytes) throw new Error(`${label}超过文件大小上限`)
      const saved = commitClaudeDesktopFiles([{ path: gatewayPath, content }], snapshots, assertContext)
      return { path: gatewayPath, backups: saved.backups }
    }),
    saveGateway: (input: ClaudeDesktopGatewayInput): Promise<ClaudeDesktopConfigResult> => serial(async () => {
      const gateway = buildClaudeDesktopGatewayConfig(input)
      assertContext()
      await options.assertUnmanaged?.()
      assertContext()
      const snapshots = new Map<string, string | null>()
      const capture = (filePath: string) => {
        const content = read(filePath)
        snapshots.set(filePath, content)
        return content
      }
      const metadata = parseMetadata(capture(metadataPath))
      const owner = parseOwner(capture(markerPath), profileDirectory)
      const id = owner?.id ?? randomUUID()
      const gatewayPath = path.join(libraryDirectory, `${id}.json`)
      const previousGatewayContent = capture(gatewayPath)
      if (!owner && (previousGatewayContent !== null || metadata.entries.some((entry) => entry.id.toLowerCase() === id.toLowerCase()))) {
        throw new Error(`${label}新配置标识冲突，请重试`)
      }
      const previousGateway = parseObject(previousGatewayContent)
      const desktop = parseObject(capture(configPath))
      const nextMetadata: LibraryMetadata = {
        ...metadata,
        appliedId: id,
        entries: metadata.entries.some((entry) => entry.id === id) ? metadata.entries : [...metadata.entries, { id, name: '星芒 AI' }],
      }
      delete nextMetadata.hybridPointer
      // Reuse only the profile recorded by the toolbox; never overwrite a user's selected profile.
      const nextGateway = { ...previousGateway, ...gateway }
      for (const key of Object.keys(nextGateway)) {
        if (key.startsWith('bootstrap') || key.startsWith('selfHosted') || /^inference.*(?:helper|oidc)/i.test(key)) delete nextGateway[key]
      }
      const plans = [
        { path: gatewayPath, content: json(nextGateway) },
        ...developerDirectories.map((directory) => {
          const developerPath = path.join(directory, 'developer_settings.json')
          return { path: developerPath, content: json({ ...parseObject(capture(developerPath)), allowDevTools: true }) }
        }),
        { path: configPath, content: json({ ...desktop, deploymentMode: '3p' }) },
        { path: metadataPath, content: json(nextMetadata) },
        { path: markerPath, content: json({ version: 1, profileDirectory: identity, id } satisfies OwnedProfile) },
      ]
      for (const plan of plans) if (Buffer.byteLength(plan.content, 'utf8') > maximumBytes) throw new Error(`${label}超过文件大小上限`)
      await options.assertUnmanaged?.()
      assertContext()
      const saved = commitClaudeDesktopFiles(plans, snapshots, assertContext)
      return {
        path: gatewayPath, ...saved, mode: 'local', supportsRelay: true, restartRequired: true, connectionVerified: false,
        warnings: ['已保存到 Claude Desktop 的第三方推理配置；完全退出并重新打开客户端后生效。尚未验证真实推理连接。'],
      }
    }),
  }
}
