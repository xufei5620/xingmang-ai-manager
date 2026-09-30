import type { UpdateSnapshot } from '../../../../electron/ipc-contract'

/** 「必须更新」那层提示上，主按钮点下去要做的事。 */
export type RequiredUpdateAction = 'check' | 'download' | 'install'

export interface RequiredUpdateGateState {
  minimumVersion: string
  currentVersion: string
  availableVersion: string | null
  /** 主按钮；null＝正在忙（检查、下载、重启安装），按钮只显示进度、点不了。 */
  action: RequiredUpdateAction | null
  label: string
  percent: number | null
  /** 上一步失败时给用户看的那句话；这时才出现「打开下载页」。 */
  failure: string | null
}

type GateSnapshot = Pick<UpdateSnapshot, 'phase' | 'currentVersion' | 'availableVersion' | 'error' | 'failedStep' | 'development' | 'rollback' | 'progress' | 'requiredVersion'>

/**
 * 状态文件说本机低于最低版本时，那层关不掉的提示该长什么样；不该拦时返回 null。
 *
 * 这层提示会把付费客户挡在门外，所以只在「确实有东西可以更新」时拦：检查过后说没有
 * 更新的版本（最低版本定得比线上发布的还高、或新版本被撤回），
 * 就不拦——拦了也没有可装的，只会把人困住。找到的是一个更旧的版本（退回）也不拦，
 * 那不是最低版本要的东西。
 */
export function requiredUpdateGate(update: GateSnapshot | null | undefined, installing = false): RequiredUpdateGateState | null {
  const minimumVersion = update?.requiredVersion
  if (!update || !minimumVersion || update.development) return null
  if (update.phase === 'disabled' || update.phase === 'not-available' || update.rollback) return null
  const base = {
    minimumVersion,
    currentVersion: update.currentVersion,
    availableVersion: update.availableVersion ?? null,
    percent: null,
    failure: null,
  }
  switch (update.phase) {
    case 'checking':
      return { ...base, action: null, label: '正在检查新版本…' }
    case 'idle':
      return { ...base, action: 'check', label: '立即更新' }
    case 'available':
    case 'cancelled':
      return { ...base, action: 'download', label: '立即更新' }
    case 'downloading': {
      const percent = Math.round(Math.min(100, Math.max(0, update.progress?.percent ?? 0)))
      return { ...base, action: null, label: `正在下载 ${percent}%`, percent }
    }
    case 'downloaded':
      if (update.error) return { ...base, action: 'install', label: '重试', failure: update.error.message }
      return installing
        ? { ...base, action: null, label: '正在重启安装…' }
        : { ...base, action: 'install', label: '立即更新' }
    case 'error':
      // 检查或下载失败后，electron-updater 已经不在「可下载」状态：从检查重新来，找到后
      // 那层提示会接着自动下载。
      return { ...base, action: 'check', label: '重试', failure: update.error?.message ?? '更新没有完成' }
  }
}

/** 主按钮点过之后，状态走到下一步要不要替用户接着做（下载完接着装）。 */
export function requiredUpdateFollowUp(update: GateSnapshot | null | undefined): Exclude<RequiredUpdateAction, 'check'> | null {
  if (!update || update.error) return null
  if (update.phase === 'available') return 'download'
  if (update.phase === 'downloaded') return 'install'
  return null
}
