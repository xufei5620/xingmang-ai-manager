import path from 'node:path'
import { providerIds, type ProviderId } from './catalog'
import { findBlockedCliVersion } from './cli-verified-versions'
import { isExactCliVersion, isNewerVersion } from './versions'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

const fileLabel = '工具更新记录'
const fileName = 'cli-update-history.json'
const maximumBytes = 8 * 1024

/** 更新后多久内还给「退回更新前的版本」。过了这段时间出的问题多半与这次更新无关。 */
export const cliRevertWindowMs = 14 * 24 * 60 * 60 * 1000

export interface CliUpdateRecord {
  /** 更新前装着的版本,也是「退回」要装回去的版本。 */
  from: string
  /** 这次更新装上的版本。 */
  to: string
  /** 更新完成的时间(毫秒)。 */
  at: number
}

export type CliUpdateHistory = Partial<Record<ProviderId, CliUpdateRecord>>

function isProviderKey(value: string): value is ProviderId {
  return (providerIds as readonly string[]).includes(value)
}

function parseRecord(value: unknown): CliUpdateRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isExactCliVersion(record.from)) return null
  if (!isExactCliVersion(record.to)) return null
  if (typeof record.at !== 'number' || !Number.isSafeInteger(record.at) || record.at <= 0) return null
  return { from: record.from, to: record.to, at: record.at }
}

/**
 * 读不懂的整份文件、读不懂的单条都当作没有记录。这份记录只决定菜单里多不多
 * 一项,丢了的代价是这一次退不回去,不值得为它报错打断首页。
 */
export function parseCliUpdateHistory(content: string | null): CliUpdateHistory {
  if (content === null) return {}
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const value = parsed as Record<string, unknown>
    if (value.version !== 1 || !value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)) return {}
    const history: CliUpdateHistory = {}
    for (const [key, entry] of Object.entries(value.tools as Record<string, unknown>)) {
      if (!isProviderKey(key)) continue
      const record = parseRecord(entry)
      if (record) history[key] = record
    }
    return history
  } catch {
    return {}
  }
}

/**
 * 更新成功后要不要记一笔。只记「本工具把已装的版本换成了另一个版本」:
 * 首次安装没有可退的版本；显式升级也要保留退回入口。显式降版不记，
 * 否则「退回」会反过来再指向刚退掉的那一版。
 */
export function buildCliUpdateRecord(
  from: string | null,
  to: string | null,
  requested: boolean,
  now: number,
): CliUpdateRecord | null {
  if (!from || !to || from === to) return null
  if (!isExactCliVersion(from) || !isExactCliVersion(to)) return null
  if (requested && !isNewerVersion(from, to)) return null
  return { from, to, at: now }
}

/**
 * 可以退回的版本;不能退时 null。现在装的必须正是记录里更到的那一版
 * (用户之后又换过版本,这条记录就不再说明眼前的情况),还在期限内,而且
 * 要退回的版本不在已知有问题的名单里——不能把人送回一个明知会坏的版本。
 */
export function resolveCliRevertVersion(
  provider: ProviderId,
  record: CliUpdateRecord | undefined,
  installedVersion: string | null,
  now: number,
  siteId?: string | null,
): string | null {
  if (!record) return null
  if (installedVersion?.trim() !== record.to) return null
  if (record.at > now || now - record.at > cliRevertWindowMs) return null
  if (findBlockedCliVersion(provider, record.from, siteId)) return null
  return record.from
}

export class CliUpdateHistoryStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {
    this.filePath = path.join(directory, fileName)
  }

  read(): CliUpdateHistory {
    try {
      return parseCliUpdateHistory(readSafeUtf8FileSync(this.filePath, fileLabel, maximumBytes))
    } catch {
      return {}
    }
  }

  /** 每个工具只留最近一笔;过期的顺手清掉,文件不会越攒越大。 */
  record(provider: ProviderId, record: CliUpdateRecord): Promise<void> {
    const next = this.queue.then(async () => {
      const history = this.read()
      history[provider] = record
      const tools: CliUpdateHistory = {}
      for (const id of providerIds) {
        const entry = history[id]
        if (entry && record.at - entry.at <= cliRevertWindowMs) tools[id] = entry
      }
      ensureSafeDataDirectory(this.directory, fileLabel)
      await writeAtomicSafeUtf8File(this.filePath, `${JSON.stringify({ version: 1, tools })}\n`, fileLabel)
    })
    this.queue = next.catch(() => undefined)
    return next
  }
}
