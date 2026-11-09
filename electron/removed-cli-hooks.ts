import path from 'node:path'
import { type ActiveProviderId, isActiveProviderId } from './catalog'
import type { ManagedCliHookPart } from './config-files'
import { readSafeUtf8File, removeSafeDataFile, writeAtomicSafeUtf8File } from './safe-local-data'

// 卸载星芒时收回了哪几家工具里的提醒设置（钩子、Claude Code 的状态行），记在数据目录里。卸载默认留着
// 数据目录和登录，客户「卸了重装」回来首页一切正常，做完提醒、防睡和状态栏却悄悄没了；重装后开机按这份
// 记录补回（config-save-service.ts 的 restoreCliHooksRemovedByUninstall），补完划掉。只认这份记录：
// 客户自己删掉的提醒没有记录，照旧不补回（同 app-settings.ts 的 seededToolDefaults 一个口径）。
//
// Windows 上写这份记录的是带着管理员身份的卸载清理（uninstall-cleanup.ts），读它的是客户自己权限的桌面
// 进程。读写都走 safe-local-data（I8）；内容只是几家工具的名字和配置文件位置，补回之前还要核对位置就是
// 这次算出来的那一份，被人改过也只能让星芒往自己本来就会写的那份文件里补自己那几条。

export const removedCliHooksRecordName = 'cli-hooks-removed-by-uninstall.json'

const maximumRecordBytes = 16 * 1024
const maximumConfigPathLength = 4096
const knownParts: readonly ManagedCliHookPart[] = ['hooks', 'statusLine']

export interface RemovedCliHooks {
  provider: ActiveProviderId
  parts: ManagedCliHookPart[]
  /** 当时收回的是哪一份文件（providerConfigPaths 的第一份）。重装后算出来不是这一份就不补，免得补进别的目录。 */
  configPath: string
}

export function removedCliHooksRecordPath(dataDirectory: string): string {
  return path.join(dataDirectory, removedCliHooksRecordName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseParts(value: unknown): ManagedCliHookPart[] {
  if (!Array.isArray(value)) return []
  return knownParts.filter((part) => value.includes(part))
}

function parseEntry(value: unknown): RemovedCliHooks | null {
  if (!isRecord(value) || !isActiveProviderId(value.provider)) return null
  const parts = parseParts(value.parts)
  const configPath = value.configPath
  if (!parts.length || typeof configPath !== 'string' || configPath.length > maximumConfigPathLength
    || configPath.includes('\0') || !path.isAbsolute(configPath)) return null
  return { provider: value.provider, parts, configPath }
}

/** 读坏了、版本不认识都当没有：最坏是这次不补，跟没有这份记录时一样。 */
export function parseRemovedCliHooks(content: string): RemovedCliHooks[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) return []
  let entries: RemovedCliHooks[] = []
  for (const value of parsed.entries) {
    const entry = parseEntry(value)
    if (entry) entries = mergeRemovedCliHooks(entries, [entry])
  }
  return entries
}

/**
 * 同一家只留一条：位置相同就把几样合在一起（卸了、装回不补的旧版、又卸了一次），位置变了以新的为准。
 */
export function mergeRemovedCliHooks(
  existing: readonly RemovedCliHooks[],
  fresh: readonly RemovedCliHooks[],
): RemovedCliHooks[] {
  const merged = existing.map((entry) => ({ ...entry, parts: [...entry.parts] }))
  for (const entry of fresh) {
    const index = merged.findIndex((candidate) => candidate.provider === entry.provider)
    if (index < 0) {
      merged.push({ ...entry, parts: [...entry.parts] })
      continue
    }
    const current = merged[index]
    const parts = current.configPath === entry.configPath
      ? knownParts.filter((part) => current.parts.includes(part) || entry.parts.includes(part))
      : [...entry.parts]
    merged[index] = { ...entry, parts }
  }
  return merged
}

export function removedCliHooksContent(entries: readonly RemovedCliHooks[]): string {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
}

/** Windows 的路径不分大小写；两边都是同一段代码拼出来的，这里只防盘符、用户名的大小写不一样。 */
export function sameRemovedCliHooksConfigPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 没有这份记录是 []；记录被换成链接之类读不了的照样抛出，由调用方记日志。 */
export async function readRemovedCliHooks(dataDirectory: string): Promise<RemovedCliHooks[]> {
  const content = await readSafeUtf8File(removedCliHooksRecordPath(dataDirectory), '卸载时收回的提醒设置记录', maximumRecordBytes)
  return content === null ? [] : parseRemovedCliHooks(content)
}

/**
 * 卸载时调：把这次收回的几家并进已有的记录。数据目录不在（从没打开过星芒）就不建，交给 writeAtomicSafeUtf8File
 * 报错，由调用方记一行。
 */
export async function rememberRemovedCliHooks(dataDirectory: string, fresh: readonly RemovedCliHooks[]): Promise<void> {
  if (!fresh.length) return
  let existing: RemovedCliHooks[] = []
  try {
    existing = await readRemovedCliHooks(dataDirectory)
  } catch {
    // 读不了的那份，写的时候 writeAtomicSafeUtf8File 按同一套检查拒绝并报出来。
  }
  await writeAtomicSafeUtf8File(
    removedCliHooksRecordPath(dataDirectory),
    removedCliHooksContent(mergeRemovedCliHooks(existing, fresh)),
    '卸载时收回的提醒设置记录',
  )
}

/** 开机补完以后调：还没补上的写回去，一家都不剩就删掉这份记录。 */
export async function replaceRemovedCliHooks(dataDirectory: string, remaining: readonly RemovedCliHooks[]): Promise<void> {
  const recordPath = removedCliHooksRecordPath(dataDirectory)
  if (!remaining.length) {
    await removeSafeDataFile(recordPath, '卸载时收回的提醒设置记录')
    return
  }
  await writeAtomicSafeUtf8File(recordPath, removedCliHooksContent(remaining), '卸载时收回的提醒设置记录')
}

export interface RemovedCliHooksRestoreStep {
  /** 这次要补的几样；空 = 这家这次不写文件。 */
  restore: ManagedCliHookPart[]
  /** 补完还要留在记录里的那条（这台电脑现在写不出来的那几样）；null = 从记录里划掉。 */
  keep: RemovedCliHooks | null
}

/**
 * 开机看到一条记录该怎么办。位置对不上（比如后来设了 CODEX_HOME）的划掉不补：卸载改的不是这份文件。
 * 现在已经有的（客户重新保存过配置，或者指向旧位置、归「修好它」管）划掉不补。写得出来的这次补；
 * 写不出来的（没有运行环境，或 Windows 上 Grok 推到了 cmd）留到下次开机。
 */
export function planRemovedCliHooksRestore(input: {
  entry: RemovedCliHooks
  currentConfigPath: string
  present: readonly ManagedCliHookPart[]
  hooksWritable: boolean
  statusLineWritable: boolean
  platform: NodeJS.Platform
}): RemovedCliHooksRestoreStep {
  const { entry } = input
  if (!sameRemovedCliHooksConfigPath(input.currentConfigPath, entry.configPath, input.platform)) return { restore: [], keep: null }
  const missing = entry.parts.filter((part) => !input.present.includes(part))
  const restore = missing.filter((part) => part === 'hooks' ? input.hooksWritable : input.statusLineWritable)
  const rest = missing.filter((part) => !restore.includes(part))
  return { restore, keep: rest.length ? { ...entry, parts: rest } : null }
}
