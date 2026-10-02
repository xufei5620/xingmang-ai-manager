import path from 'node:path'
import { createClaudeDesktopConfigService, type ClaudeDesktopModelRepairOutcome } from './claude-desktop-config'
import { listClaudeDesktopProfileCandidates } from './claude-desktop-paths'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

const markerLabel = 'Claude Desktop 型号清单修复记录'
const completedContent = '{"version":1,"completed":true}\n'
// 写不进去（文件被占用、被别的程序改了一半）下次开机再试，最多三次：每次失败都会在
// Claude 的配置目录旁留一份备份，不能无限开机无限留。
const maximumAttempts = 3

export interface ClaudeDesktopModelRepairOptions {
  platform: NodeJS.Platform
  userHome: string
  env?: NodeJS.ProcessEnv
  /** 星芒各站给 Claude 用的网关地址；配置里的地址不在其中就不是星芒的，不碰。 */
  relayBaseUrls: readonly string[]
}

export interface ClaudeDesktopModelRepairReport {
  /** 以前已经查完了，这次什么都没读。 */
  skipped: boolean
  /** 改回只剩一个型号的配置份数。 */
  repaired: number
  backups: number
  /** 星芒写过但认不准的，原因代码，只进日志。 */
  unrecognized: Array<Extract<ClaudeDesktopModelRepairOutcome, { status: 'unrecognized' }>['reason']>
  /** 这次没写成的错误原话，只进日志；有它就留着下次开机再试。 */
  failures: string[]
}

function previousAttempts(markerPath: string): number | null {
  const marker = readSafeUtf8FileSync(markerPath, markerLabel, 1024)
  if (marker === null) return 0
  if (marker === completedContent) return null
  const attempts = /^\{"version":1,"attempts":([12])\}\n$/.exec(marker)
  if (!attempts) throw new Error(`${markerLabel}损坏，未执行修改`)
  return Number(attempts[1])
}

/**
 * 0.2.12 保存 Claude Desktop 配置时写进了一串型号（#685），Claude Desktop 因此发消息没有回复；
 * #746 起保存只写选中的那一个，但已经写错的不会自己改回来。这里开机替客户改回一次：只认
 * 星芒自己那份（工具箱的归属记录认领得到的目录），只认 0.2.12 那个写法。查完记一笔，以后
 * 开机只读这一笔；没装 Claude Desktop、从没配过、早已改好的也算查完。
 */
export async function runClaudeDesktopModelRepair(
  managerDataDirectory: string,
  options: ClaudeDesktopModelRepairOptions,
): Promise<ClaudeDesktopModelRepairReport> {
  const directory = path.join(managerDataDirectory, 'migrations')
  const markerPath = path.join(directory, 'claude-desktop-single-model-v1.json')
  const report: ClaudeDesktopModelRepairReport = { skipped: false, repaired: 0, backups: 0, unrecognized: [], failures: [] }
  const attempts = previousAttempts(markerPath)
  if (attempts === null) return { ...report, skipped: true }
  for (const profileDirectory of listClaudeDesktopProfileCandidates(options)) {
    try {
      const outcome = await createClaudeDesktopConfigService({ dataDirectory: managerDataDirectory, profileDirectory })
        .repairLegacyModelList(options.relayBaseUrls)
      if (outcome.status === 'repaired') {
        report.repaired++
        report.backups += outcome.backups.length
      } else if (outcome.status === 'unrecognized') report.unrecognized.push(outcome.reason)
    } catch (error) {
      report.failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  const next = report.failures.length && attempts + 1 < maximumAttempts
    ? `{"version":1,"attempts":${attempts + 1}}\n`
    : completedContent
  try {
    ensureSafeDataDirectory(directory, markerLabel)
    await writeAtomicSafeUtf8File(markerPath, next, markerLabel)
  } catch (error) {
    // 记不下来不能吞掉这次已经改好的结论：界面还要说一句。下次开机会再查一遍，
    // 改好的那份已经只剩一个型号，不会再写。
    report.failures.push(error instanceof Error ? error.message : String(error))
  }
  return report
}
