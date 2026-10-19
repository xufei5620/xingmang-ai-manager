// 一次检测里没检测成的那几项，各写成一行日志（客服在反馈报告里看原因）。首页那次检测（system.ts）和
// 外部客户端那次检测（external-clients.ts）共用，#1070 第 7 步从 ipc.ts 原样搬来。
import { externalClientNames, type ExternalClientStatus } from '../../external-client-contract'
import type { SystemSnapshot } from '../../system-service'
import { providerDisplayName } from '../handler-log'

const runtimeToolNames: Readonly<Record<keyof SystemSnapshot['runtime'], string>> = {
  node: 'Node.js',
  npm: 'npm',
  python: 'Python',
  git: 'Git',
}

function isRuntimeToolId(value: string): value is keyof SystemSnapshot['runtime'] {
  return Object.hasOwn(runtimeToolNames, value)
}

export interface DetectionFailureLogLine {
  event: string
  name: string
  /** 探针给的原话；没给的是 null。 */
  reason: string | null
  detail: Record<string, unknown>
}

/**
 * 这次扫描里检测失败的那几项（第二十六批 D）。界面上只按原因说一句中文，英文原话（EPERM
 * 之类）不再上屏，靠这几行进日志，客服在反馈报告里才看得到。以前 scan.completed 里只记
 * 装没装、版本号，反馈报告也只写「检测失败」四个字。
 */
export function scanDetectionFailures(snapshot: Pick<SystemSnapshot, 'runtime' | 'clis' | 'desktopApps'>): DetectionFailureLogLine[] {
  const lines: DetectionFailureLogLine[] = []
  for (const [id, status] of Object.entries(snapshot.runtime)) {
    if (status.detectionFailed !== true) continue
    lines.push({ event: 'runtime.detection-failed', name: isRuntimeToolId(id) ? runtimeToolNames[id] : id, reason: status.detectionError || null, detail: { tool: id } })
  }
  for (const [provider, status] of Object.entries(snapshot.clis)) {
    if (status.detectionFailed !== true) continue
    lines.push({ event: 'cli.detection-failed', name: providerDisplayName(provider) ?? provider, reason: status.detectionError || null, detail: { provider } })
  }
  const desktop = snapshot.desktopApps.codex
  if (desktop.detectionFailed === true) {
    lines.push({ event: 'desktop.detection-failed', name: 'Codex 桌面端', reason: desktop.detectionError || null, detail: {} })
  }
  return lines
}

/** 外部客户端（WorkBuddy、Claude Desktop、OpenCode）同理：detectionError 有值就是这次没检测成。 */
export function externalClientDetectionFailures(statuses: readonly Pick<ExternalClientStatus, 'tool' | 'detectionError'>[]): DetectionFailureLogLine[] {
  return statuses.filter((status) => status.detectionError).map((status) => ({
    event: 'external-client.detection-failed',
    name: externalClientNames[status.tool],
    reason: status.detectionError,
    detail: { tool: status.tool },
  }))
}
