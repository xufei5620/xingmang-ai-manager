import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ProviderId } from './catalog'
import type { NativeConfigInspection } from './config-files'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

/**
 * `changed` 只收窄 `unknown` 的一角：这份配置确实是本程序替当前账号写下的，
 * 之后指纹又对不上了（用户手改、CLI 自己的登录流程改写、另一个管理工具覆盖）。
 * 分出来是为了能在首页说一句「配置被改过」并给出修复入口；判不准的一律照旧
 * 落回 `unknown`，因为那一侧的每条路径都受「来源未确认就不自动改写」保护。
 */
export type ToolConfigOwnership = 'account' | 'manual' | 'unknown' | 'missing' | 'changed'
interface OwnershipRecord {
  version: 1 | 2
  provider: ProviderId
  source: 'account' | 'manual' | 'unknown'
  identity: string
  owner?: string
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** A digest binds consent to the actual paths, endpoint, and credential without storing the key. */
export function toolConfigIdentity(config: NativeConfigInspection): string {
  return createHash('sha256').update(JSON.stringify({
    paths: config.files.map((file) => normalizedPath(file.path)),
    baseUrl: config.actualBaseUrl, key: config.apiKey,
    authType: config.authType ?? null, codexAuthMode: config.codexAuthMode ?? null,
  })).digest('hex')
}

export class ToolConfigOwnershipStore {
  constructor(private readonly directory: string) {}

  private file(provider: ProviderId, config: NativeConfigInspection): string {
    const location = createHash('sha256').update(config.files.map((file) => normalizedPath(file.path)).join('\0')).digest('hex')
    return path.join(this.directory, `${provider}-${location}.json`)
  }

  read(provider: ProviderId, config: NativeConfigInspection, owner: string | null = null): ToolConfigOwnership {
    if (!config.exists && !config.hasApiKey) return 'missing'
    if (!config.hasApiKey) return 'unknown'
    try {
      const raw = readSafeUtf8FileSync(this.file(provider, config), '工具配置来源', 4096)
      if (raw === null) return 'unknown'
      const value = JSON.parse(raw) as OwnershipRecord
      if ((value.version !== 1 && value.version !== 2) || value.provider !== provider) return 'unknown'
      // Legacy account records prove a write happened, but do not identify who consented.
      const ours = value.source === 'account' && value.version === 2 && Boolean(owner) && value.owner === owner
      if (value.identity !== toolConfigIdentity(config)) return ours ? 'changed' : 'unknown'
      if (value.source === 'manual') return 'manual'
      return ours ? 'account' : 'unknown'
    } catch { return 'unknown' }
  }

  async write(provider: ProviderId, config: NativeConfigInspection, source: 'account' | 'manual' | 'unknown', owner: string | null = null): Promise<void> {
    if (source === 'account' && !owner) throw new Error('请先登录账号再保存账号配置来源')
    ensureSafeDataDirectory(this.directory, '工具配置来源目录')
    const value: OwnershipRecord = {
      version: 2, provider, source, identity: toolConfigIdentity(config),
      ...(source === 'account' && owner ? { owner } : {}),
    }
    await writeAtomicSafeUtf8File(this.file(provider, config), JSON.stringify(value) + '\n', '工具配置来源')
  }
}
