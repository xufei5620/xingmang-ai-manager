import type { XingmangApi } from '../../../../electron/ipc-contract'
import { errorMessage } from '../../business-common'

type SystemSnapshot = Awaited<ReturnType<XingmangApi['scanSystem']>>
type PlatformCapability = Awaited<ReturnType<XingmangApi['getPlatformCapabilities']>>

/** 安装卸载页一次读取里互相独立的两块。 */
export type MaintenancePartition = 'system' | 'platform'

export interface MaintenancePartitionFailure {
  partition: MaintenancePartition
  message: string
}

export interface MaintenanceStatus {
  /** 工具与运行环境的检测结果；这一块没读到时为 null。 */
  snapshot: SystemSnapshot | null
  /** 当前系统支持哪些安装与卸载；这一块没读到时为 null。 */
  capability: PlatformCapability | null
  failures: MaintenancePartitionFailure[]
}

/**
 * 两块分开结算（对照工具页的 createToolsApi().read()）。这两块回答的是不同的
 * 问题——「装了什么」与「这台机器允许装什么」——此前串行 await，任意一块失败
 * 都让整页的工具行退回未知态，还把「未安装」当成结论显示出来。
 */
export function buildMaintenanceStatus(
  system: PromiseSettledResult<SystemSnapshot>,
  platform: PromiseSettledResult<PlatformCapability>,
): MaintenanceStatus {
  const failures: MaintenancePartitionFailure[] = []
  if (system.status === 'rejected')
    failures.push({ partition: 'system', message: errorMessage(system.reason, '工具状态没有读到，请重新检测。') })
  if (platform.status === 'rejected')
    failures.push({ partition: 'platform', message: errorMessage(platform.reason, '当前系统支持的操作没有读到，请重新检测。') })
  return {
    snapshot: system.status === 'fulfilled' ? system.value : null,
    capability: platform.status === 'fulfilled' ? platform.value : null,
    failures,
  }
}

export async function readMaintenanceStatus(
  api: Pick<XingmangApi, 'scanSystem' | 'getPlatformCapabilities'>,
): Promise<MaintenanceStatus> {
  const [system, platform] = await Promise.allSettled([
    api.scanSystem(false),
    api.getPlatformCapabilities(),
  ])
  return buildMaintenanceStatus(system, platform)
}

export interface MaintenanceFailureNotice {
  title: string
  reason: string
  hint: string
}

/**
 * 缺了哪一块，用户能做什么就不一样：工具状态缺席时页面上的每一行都还没有结论，
 * 而系统能力缺席时状态仍然可信，只是按钮暂时点不动。文案分开写，别让用户
 * 以为工具真的不见了。
 */
export function maintenanceFailureNotice(failure: MaintenancePartitionFailure): MaintenanceFailureNotice {
  return failure.partition === 'system'
    ? {
        title: '工具状态暂未读到',
        reason: failure.message,
        hint: '下面各行的版本与安装状态都还没有结论，安装日志和卸载入口不受影响。点「重新检测」可以再试一次。',
      }
    : {
        title: '当前系统支持的操作暂未读到',
        reason: failure.message,
        hint: '工具的版本与安装状态照常显示；在读到之前，安装与卸载按钮暂时点不动。点「重新检测」可以再试一次。',
      }
}
