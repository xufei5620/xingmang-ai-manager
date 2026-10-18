import path from 'node:path'
import { createHash } from 'node:crypto'
import { isExternalToolId } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

/**
 * 客户端里这把 Key 是从哪来的（#1113）：configured = 用某个工具当前那把，account = 从账号里挑的，
 * manual = 客户自己填的。Claude Code 换了 Key 时，客户自己填的那把不跟着换。
 */
export type ExternalClientKeySource = 'configured' | 'account' | 'manual'

interface OwnershipRecord {
  version: 1
  tool: ExternalToolId
  identity: string
  /** 缺省 = 0.2.20 以前保存的，没记来源。 */
  source?: ExternalClientKeySource
  /**
   * 跟着 Claude Code 换 Key 换到一半（#1113）：客户端那份正要换成这一把。先记下再改客户端，改完才把它挪成
   * identity；中间断了，两把都认，不会让客户端换上了新 Key、首页却不认它。
   */
  next?: string
}

const keySources: readonly string[] = ['configured', 'account', 'manual'] satisfies ExternalClientKeySource[]

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function invalid(): never { throw new Error('外部客户端配置归属参数无效') }

function ownershipIdentity(tool: ExternalToolId, owner: string | null, baseUrl: string, apiKey: string) {
  if (!isExternalToolId(tool) || typeof owner !== 'string' || !owner.trim() || owner !== owner.trim()
    || owner.length > 1024 || /[\u0000-\u001f\u007f]/.test(owner)) invalid()
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 16384 || /\s|[\u0000-\u001f\u007f]/.test(apiKey)) invalid()
  if (typeof baseUrl !== 'string' || !baseUrl.trim() || baseUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(baseUrl)) invalid()
  let endpoint: URL
  try { endpoint = new URL(baseUrl.trim()) } catch { return invalid() }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) invalid()
  const normalizedBaseUrl = endpoint.toString().replace(/\/+$/, '')
  return { filename: `${digest([tool, owner])}.json`, identity: digest([normalizedBaseUrl, apiKey]) }
}

/** Account ownership is local evidence of an explicit configuration, not a credential vault. */
export class ExternalClientOwnershipStore {
  constructor(private readonly directory: string) {}

  matches(tool: ExternalToolId, owner: string | null, baseUrl: string, apiKey: string): boolean {
    return this.inspect(tool, owner, baseUrl, apiKey) !== null
  }

  /** 归属对得上时交出记着的来源（没记是 {}）；对不上、读不了一律 null。 */
  inspect(tool: ExternalToolId, owner: string | null, baseUrl: string, apiKey: string): { source?: ExternalClientKeySource } | null {
    try {
      const expected = ownershipIdentity(tool, owner, baseUrl, apiKey)
      const entry = this.read(tool, expected.filename)
      if (!entry || (entry.identity !== expected.identity && entry.next !== expected.identity)) return null
      return entry.source ? { source: entry.source } : {}
    } catch { return null }
  }

  async write(tool: ExternalToolId, owner: string, baseUrl: string, apiKey: string, source?: ExternalClientKeySource): Promise<void> {
    const { filename, identity } = ownershipIdentity(tool, owner, baseUrl, apiKey)
    await this.save(filename, { version: 1, tool, identity, ...(source ? { source } : {}) })
  }

  /** 同一份配置换了地址或 Key（换线路、跟着 Claude Code 换 Key）：照旧记着原来的来源。 */
  async rewrite(tool: ExternalToolId, owner: string, baseUrl: string, apiKey: string): Promise<void> {
    const { filename, identity } = ownershipIdentity(tool, owner, baseUrl, apiKey)
    const source = this.recordedSource(tool, filename)
    await this.save(filename, { version: 1, tool, identity, ...(source ? { source } : {}) })
  }

  /** 换 Key 之前先记下新那把（见 OwnershipRecord.next）。只在原来那把确实是记着的那一把时才记。 */
  async stageKey(tool: ExternalToolId, owner: string, baseUrl: string, apiKey: string, nextKey: string): Promise<void> {
    const current = ownershipIdentity(tool, owner, baseUrl, apiKey)
    const next = ownershipIdentity(tool, owner, baseUrl, nextKey)
    const entry = this.read(tool, current.filename)
    if (!entry || (entry.identity !== current.identity && entry.next !== current.identity)) throw new Error('外部客户端配置归属已变化')
    await this.save(current.filename, { version: 1, tool, identity: current.identity, ...(entry.source ? { source: entry.source } : {}), next: next.identity })
  }

  private read(tool: ExternalToolId, filename: string): OwnershipRecord | null {
    const raw = readSafeUtf8FileSync(path.join(this.directory, filename), '外部客户端配置归属', 4096)
    if (raw === null) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const entry = value as OwnershipRecord
    if (entry.version !== 1 || entry.tool !== tool || typeof entry.identity !== 'string' || !entry.identity) return null
    return {
      version: 1, tool, identity: entry.identity,
      ...(typeof entry.source === 'string' && keySources.includes(entry.source) ? { source: entry.source } : {}),
      ...(typeof entry.next === 'string' && entry.next ? { next: entry.next } : {}),
    }
  }

  // 读不出原来那份（没有、坏了、被换成了链接）就当没记来源：换线路、换 Key 本身照旧做。
  private recordedSource(tool: ExternalToolId, filename: string): ExternalClientKeySource | undefined {
    try { return this.read(tool, filename)?.source } catch { return undefined }
  }

  private async save(filename: string, entry: OwnershipRecord): Promise<void> {
    ensureSafeDataDirectory(this.directory, '外部客户端配置归属目录')
    await writeAtomicSafeUtf8File(path.join(this.directory, filename), JSON.stringify(entry) + '\n', '外部客户端配置归属')
  }
}
