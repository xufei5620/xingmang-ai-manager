import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser'
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

  return {
    inspectConnection: async (expectedBaseUrl: string, belongsToCurrentAccount?: (apiKey: string) => boolean): Promise<ExternalClientConnectionStatus> => {
      try {
        await options.assertUnmanaged?.()
        const desktop = parseObject(read(configPath))
        const metadata = parseMetadata(read(metadataPath))
        const owner = parseOwner(read(markerPath), profileDirectory)
        if (!metadata.appliedId) return { configured: false, configurationReady: false, model: null, configurationSource: 'missing', configurationError: null }
        const config = parseObject(read(path.join(libraryDirectory, `${metadata.appliedId}.json`)))
        if (!Object.keys(config).length && !metadata.hybridPointer) {
          return { configured: false, configurationReady: false, model: null, configurationSource: 'missing', configurationError: null }
        }
        const model = firstModel(config.inferenceModels)
        const apiKey = config.inferenceGatewayApiKey
        const baseUrl = config.inferenceGatewayBaseUrl
        const configurationReady = (desktop.deploymentMode === undefined || desktop.deploymentMode === '3p')
          && !metadata.hybridPointer && gatewayConfigurationReady(config)
        const configured = configurationReady
          && typeof baseUrl === 'string' && baseUrl.replace(/\/+$/, '') === expectedBaseUrl.replace(/\/+$/, '')
          && typeof apiKey === 'string' && Boolean(apiKey.trim())
          && (owner?.id === metadata.appliedId || Boolean(belongsToCurrentAccount))
          && (!belongsToCurrentAccount || belongsToCurrentAccount(apiKey))
        return { configured, configurationReady, model, configurationSource: configured ? 'xingmang' : 'other', configurationError: null }
      } catch {
        return { configured: false, configurationReady: false, model: null, configurationSource: 'unknown', configurationError: 'Claude Desktop 本地配置无法确认，可能存在管理策略或配置文件异常，请重新检测。' }
      }
    },
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
