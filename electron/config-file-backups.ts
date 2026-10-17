import fs from 'node:fs'
import path from 'node:path'

// 改工具配置之前在原文件旁边留的 `<文件名>.bak.<时间戳>`。保存配置的事务（config-files.ts）和
// 单改一份 Codex config.toml 的地方（codex-config-toml.ts）都往同一个目录里放，清旧的时候是一起
// 数的：两边的名字必须出自这一处，哪边换了写法，另一边就会挑错该删的那几份（#1068）。

export const MAX_CONFIG_BACKUPS_PER_FILE = 5

/** UTC 时间精确到毫秒，字典序就是时间序，staleConfigBackups 靠这个挑旧的。 */
export function configBackupSuffix(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
}

/**
 * 同一毫秒里第二份加 `-1`、`-2`。用 lstat 看占没占：一个失效的链接也算占着，
 * 不能把备份复制过去。
 */
export function uniqueConfigBackupPath(filePath: string, suffix = configBackupSuffix()): string {
  const base = `${filePath}.bak.${suffix}`
  let candidate = base
  for (let index = 1; ; index += 1) {
    try {
      fs.lstatSync(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
    candidate = `${base}-${index}`
  }
}

/**
 * 这个文件除最近 keep 份以外的备份，最旧的在前。只给路径不删：删之前怎么查路径
 * 由调用方定（保存配置那边要查在不在工具配置目录里）。读不了目录就当没有。
 */
export function staleConfigBackups(filePath: string, keep = MAX_CONFIG_BACKUPS_PER_FILE): string[] {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.bak.`
  let entries: string[]
  try {
    entries = fs.readdirSync(directory)
  } catch {
    return []
  }
  const backups = entries.filter((name) => name.startsWith(prefix)).sort()
  return backups.slice(0, Math.max(0, backups.length - keep)).map((name) => path.join(directory, name))
}
