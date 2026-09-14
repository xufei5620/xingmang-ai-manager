import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

const fileLabel = '公告已读记录'
const maximumIds = 200
const maximumBytes = 24 * 1024
const scopePattern = /^xm-account:([1-9]\d{0,15})$/
const idPattern = /^(?:newapi|legacy)-[a-f0-9]{64}$/

/** Validate the renderer boundary separately from the backing store dependency. */
export function parseLocalNoticeReadSync(scope: unknown, ids: unknown): { scope: string; ids: string[] } {
  const matched = typeof scope === 'string' ? scopePattern.exec(scope) : null
  if (!matched || !Number.isSafeInteger(Number(matched[1]))) throw new Error('公告账号标识格式错误')
  if (!Array.isArray(ids) || ids.length > maximumIds
    || Array.from(ids).some((id) => typeof id !== 'string' || !idPattern.test(id))) {
    throw new Error('公告已读条目标识格式错误或数量超过 200 条')
  }
  return { scope: matched[0], ids: [...new Set(ids as string[])] }
}

function parseStoredIds(content: string, scope: string): string[] {
  try {
    const state: unknown = JSON.parse(content)
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid object')
    const value = state as Record<string, unknown>
    if (Object.keys(value).length !== 3 || value.version !== 1 || value.scope !== scope) throw new Error('invalid metadata')
    const parsed = parseLocalNoticeReadSync(value.scope, value.ids)
    if (parsed.ids.length !== (value.ids as unknown[]).length) throw new Error('duplicate ids')
    return parsed.ids
  } catch {
    // Never replace corrupt state with an empty array: doing so would turn
    // a recoverable read failure into permanent loss of every read marker.
    throw new Error('公告已读记录损坏或格式不兼容，原文件已保留')
  }
}

export class AnnouncementReadStore {
  private readonly rootDirectory: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory)
  }

  async sync(scope: string, ids: string[]): Promise<string[]> {
    const input = parseLocalNoticeReadSync(scope, ids)
    const previous = this.queues.get(input.scope) ?? Promise.resolve()
    const result = previous.then(async () => {
      // The strictly numeric user suffix produces one portable file name per
      // account, without accepting a path or a platform from the renderer.
      const filePath = path.join(this.rootDirectory, `xm-account-${input.scope.slice('xm-account:'.length)}.json`)
      const content = await readSafeUtf8File(filePath, fileLabel, maximumBytes)
      const stored = content === null ? [] : parseStoredIds(content, input.scope)
      const remembered = new Set(stored)
      // Old renderer caches are offered on every load. Reimporting existing
      // markers must not rewrite the file or make old reads evict newer ones.
      const merged = [...stored, ...input.ids.filter((id) => !remembered.has(id))].slice(-maximumIds)
      if (merged.length !== stored.length || merged.some((id, index) => id !== stored[index])) {
        ensureSafeDataDirectory(this.rootDirectory, fileLabel)
        await writeAtomicSafeUtf8File(filePath, `${JSON.stringify({ version: 1, scope: input.scope, ids: merged })}\n`, fileLabel)
      }
      return merged
    })
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(input.scope, tail)
    void tail.then(() => { if (this.queues.get(input.scope) === tail) this.queues.delete(input.scope) })
    return result
  }
}
