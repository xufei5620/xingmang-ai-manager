import { readLocalPreference, writeLocalPreference } from '../app/preferences'
import type { ToolId, ToolPresentation } from './model'

/** 一个待更新的工具，以及这次要更到的版本。 */
export interface ToolUpdateEntry {
  id: ToolId
  /** 目标版本；这次没探到版本号时是 unknown。 */
  version: string
}

const storageKey = 'xingmang-v2-cli-update-notice'
/** 通知事件编号的长度上限，与主进程 isActivityKey 的校验一致。 */
const maximumKeyLength = 160
const unknownVersion = 'unknown'

/**
 * 首页「N 个有更新」数的同一份判定：装了才谈更新，`updateAvailable` 本身已经
 * 排除了这次更新检查失败（`updateCheck: 'failed'`）和镜像其实没有新包的桌面端，
 * 所以这里不再自己判一遍，角标和卡片上的数字永远一致。
 */
export function pendingToolUpdates(tools: readonly ToolPresentation[]): ToolUpdateEntry[] {
  return tools
    .filter((tool) => tool.status.installed && tool.updateAvailable)
    .map((tool) => ({ id: tool.id, version: tool.latestVersion ?? unknownVersion }))
}

/**
 * 主进程的 isActivityKey 只收 [A-Za-z0-9:._-]，预发布版本号里的别的字符一律换成
 * `-`：这个编号只用来给同一次提醒去重，不需要还原成版本号。
 */
function keySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-')
}

export function updateNoticeKey(entries: readonly ToolUpdateEntry[]): string {
  const body = [...entries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => `${keySegment(entry.id)}.${keySegment(entry.version)}`)
    .join('_')
  return `cli-update:${body}`.slice(0, maximumKeyLength)
}

export function readAnnouncedToolUpdates(): Record<string, string> {
  const stored = readLocalPreference(storageKey)
  if (!stored) return {}
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [id, version] of Object.entries(parsed)) {
      if (typeof version === 'string') result[id] = version
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 只记这一轮还等着更新的工具：用户把某个工具更完之后它就从表里消失，
 * 将来那个工具再出新版本时自然会重新提醒一次。
 */
export function rememberAnnouncedToolUpdates(entries: readonly ToolUpdateEntry[]): boolean {
  return writeLocalPreference(
    storageKey,
    JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.id, entry.version]))),
  )
}

/**
 * 用户主动退回旧版本之后，扫描会重新看到「有新版本」——正是他刚退掉的那一版。
 * 退回之前先把它记成已提醒过，免得刚退完就弹一条通知劝他再更新回去。上游
 * 之后再出更新的版本，目标版本变了，照常提醒。
 */
export function rememberRevertedToolUpdate(id: ToolId, latestVersion: string | null): boolean {
  return writeLocalPreference(
    storageKey,
    JSON.stringify({ ...readAnnouncedToolUpdates(), [id]: latestVersion ?? unknownVersion }),
  )
}

/** 还没提醒过的那几个：同一个工具同一个目标版本只说一次，换了版本再说。 */
export function unannouncedToolUpdates(
  entries: readonly ToolUpdateEntry[],
  announced: Record<string, string>,
): ToolUpdateEntry[] {
  return entries.filter((entry) => announced[entry.id] !== entry.version)
}
