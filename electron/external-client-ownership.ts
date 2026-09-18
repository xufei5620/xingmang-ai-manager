import path from 'node:path'
import { createHash } from 'node:crypto'
import { isExternalToolId } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

interface OwnershipRecord { version: 1; tool: ExternalToolId; identity: string }

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
    try {
      const expected = ownershipIdentity(tool, owner, baseUrl, apiKey)
      const raw = readSafeUtf8FileSync(path.join(this.directory, expected.filename), '外部客户端配置归属', 4096)
      if (raw === null) return false
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const entry = value as OwnershipRecord
      return entry.version === 1 && entry.tool === tool && entry.identity === expected.identity
    } catch { return false }
  }

  async write(tool: ExternalToolId, owner: string, baseUrl: string, apiKey: string): Promise<void> {
    const { filename, identity } = ownershipIdentity(tool, owner, baseUrl, apiKey)
    ensureSafeDataDirectory(this.directory, '外部客户端配置归属目录')
    const entry: OwnershipRecord = { version: 1, tool, identity }
    await writeAtomicSafeUtf8File(path.join(this.directory, filename), JSON.stringify(entry) + '\n', '外部客户端配置归属')
  }
}
