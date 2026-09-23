/**
 * 「这次启动是不是刚更新完」与「这一版改了什么」。
 *
 * 为什么要有：更新说明原来只在发现新版本那一刻由更新清单带下来（updater.ts 的
 * releaseNotesText）。用户点了「重启并安装」，软件消失又出现，界面和之前一模一样，
 * 他只能再去点一次「检查更新」确认自己真的在新版上。这里补上最后一步：主进程记住
 * 上次运行的版本号，版本升了就在这次启动的更新快照里带上一次性的标记，改动内容
 * 来自构建时写进包里的 dist-electron/release-notes.json（scripts/bundle-release-notes.cjs），
 * 不走网络，断网也能显示。
 *
 * 两条取舍：
 * - **只在版本升高时算「刚更新」**。装回旧版本不是更新，说「已更新到 0.2.7」是假话。
 * - **没有记录时，看这台机器以前有没有跑过本软件**（有没有运行日志）。第一个带这项
 *   功能的版本发出去时，所有老用户都还没有记录；一律当成新装会让这一版正好是那个
 *   什么都不说的版本。真正的新装没有运行日志，照旧什么都不说。
 *
 * 读坏了一律降级成「没有记录」，绝不抛错：丢了这份数据最多少提示一次。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import type { InstalledRelease } from './updater'

export type { InstalledRelease }

export const BUNDLED_RELEASE_NOTES_RELATIVE_PATH = ['dist-electron', 'release-notes.json'] as const
const MAX_BUNDLED_BYTES = 128 * 1024
// 与 scripts/bundle-release-notes.cjs 的上限一致：构建端先截住，这里只防坏文件。
const MAX_NOTES = 60
const MAX_NOTE_LENGTH = 1000
const storeLabel = '上次运行版本记录'
const MAX_STORE_BYTES = 4 * 1024
const VERSION_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function versionParts(version: string): [number, number, number] | null {
  const match = VERSION_PATTERN.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** a 比 b 新返回正数；任一边不是 x.y.z 返回 null。 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * 包里那份文件的版本必须等于正在运行的版本：一份对不上的说明（上一次构建残留、
 * 被替换过的产物）宁可不显示，也不能把别的版本的改动当成这一版说给用户听。
 */
export function parseBundledReleaseNotes(content: string, currentVersion: string): string[] | null {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== currentVersion || !Array.isArray(value.notes)) return null
  const notes = value.notes
    .slice(0, MAX_NOTES)
    .filter((note): note is string => typeof note === 'string')
    .map((note) => note.trim().slice(0, MAX_NOTE_LENGTH))
    .filter(Boolean)
  return notes.length > 0 ? notes : null
}

export function resolveBundledReleaseNotesPath(appPath: string): string {
  return path.join(path.resolve(appPath), ...BUNDLED_RELEASE_NOTES_RELATIVE_PATH)
}

/**
 * 这份文件在 app.asar 里（打包版）或 dist-electron 里（开发版编译后），是随程序
 * 一起签发的自家资产，不在用户可写区，所以走普通读取加大小上限，而不是
 * safe-local-data 那套针对用户数据目录的 reparse/硬链接检查（asar 虚拟文件也过不了那套）。
 */
export function readBundledReleaseNotes(appPath: string, currentVersion: string): string[] | null {
  try {
    const filePath = resolveBundledReleaseNotesPath(appPath)
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_BUNDLED_BYTES) return null
    return parseBundledReleaseNotes(fs.readFileSync(filePath, 'utf8'), currentVersion)
  } catch {
    return null
  }
}

/**
 * 运行日志每次启动都会写，所以它在不在就是「这台机器以前跑没跑过本软件」；用户在
 * 反馈页清过日志时再看一眼设置文件。必须在这次启动的 RuntimeLogStore 写第一条之前调用。
 */
export function hasPriorRunRecord(managerDataDirectory: string): boolean {
  return [path.join('logs', 'runtime.jsonl'), 'settings.json'].some((relative) => {
    try {
      return fs.statSync(path.join(managerDataDirectory, relative)).isFile()
    } catch {
      return false
    }
  })
}

export function resolveInstalledRelease(input: {
  currentVersion: string
  recordedVersion: string | null
  hadPriorRun: boolean
  notes: string[] | null
}): InstalledRelease {
  const recorded = input.recordedVersion !== null && versionParts(input.recordedVersion) ? input.recordedVersion : null
  if (recorded === null) {
    return { justUpdated: input.hadPriorRun && versionParts(input.currentVersion) !== null, previousVersion: null, notes: input.notes }
  }
  const comparison = compareReleaseVersions(input.currentVersion, recorded)
  return { justUpdated: comparison !== null && comparison > 0, previousVersion: recorded, notes: input.notes }
}

export interface LastRunVersionStore {
  /** 读不到、读坏了都返回 null。 */
  read(): string | null
  write(version: string): Promise<void>
}

export function createLastRunVersionStore(options: { filePath: string }): LastRunVersionStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('上次运行版本记录必须使用绝对路径。')
  return {
    read() {
      try {
        const content = readSafeUtf8FileSync(options.filePath, storeLabel, MAX_STORE_BYTES)
        if (content === null) return null
        const value: unknown = JSON.parse(content)
        if (!isRecord(value) || value.version !== 1 || typeof value.lastRunVersion !== 'string') return null
        return versionParts(value.lastRunVersion) ? value.lastRunVersion : null
      } catch {
        return null
      }
    },
    async write(version) {
      if (!versionParts(version)) throw new Error('版本号格式无效。')
      ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
      await writeAtomicSafeUtf8File(options.filePath, `${JSON.stringify({ version: 1, lastRunVersion: version })}\n`, storeLabel)
    },
  }
}
