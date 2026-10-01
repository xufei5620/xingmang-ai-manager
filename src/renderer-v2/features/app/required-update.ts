import type { UpdateDiskShortfall, UpdateSnapshot } from '../../../../electron/ipc-contract'
import { updateDownloadDetail, updateFailureLabel } from '../../registry/business'

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
  /** 下载时进度条下面那行「已下载多少 / 共多少 · 多快 · 还要多久」；不在下载时为 null。*/
  progressDetail: string | null
  /** 上一步失败时给用户看的那句话；这时才出现「打开下载页」。 */
  failure: string | null
  /** 失败那段的标题，和更新页、首页气泡同一份（「检查更新失败」「下载更新失败」…）。 */
  failureTitle: string | null
  /**
   * 量过磁盘、空间不够，更新器这一轮没下载（它不报错，只在快照上挂这个缺口）。门里
   * 要说清为什么没动、清出空间再点；没有缺口时为 null。
   */
  diskShortfall: UpdateDiskShortfall | null
}

type GateSnapshot = Pick<UpdateSnapshot, 'phase' | 'currentVersion' | 'availableVersion' | 'error' | 'failedStep' | 'development' | 'rollback' | 'progress' | 'requiredVersion' | 'diskShortfall'>

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
    progressDetail: null,
    failure: null,
    failureTitle: null,
    diskShortfall: null,
  }
  switch (update.phase) {
    case 'checking':
      return { ...base, action: null, label: '正在检查新版本…' }
    case 'idle':
      return { ...base, action: 'check', label: '立即更新' }
    case 'available':
      // 主进程量盘发现不够时直接返回、阶段仍是 available，按钮照旧写「立即更新」的话，
      // 点下去什么都不发生，客户会被锁在门外还不知道为什么。
      if (update.diskShortfall) return { ...base, action: 'download', label: '空间够了，再试一次', diskShortfall: update.diskShortfall }
      return { ...base, action: 'download', label: '立即更新' }
    case 'cancelled':
      return { ...base, action: 'download', label: '立即更新' }
    case 'downloading': {
      const percent = Math.round(Math.min(100, Math.max(0, update.progress?.percent ?? 0)))
      return { ...base, action: null, label: `正在下载 ${percent}%`, percent, progressDetail: updateDownloadDetail(update.progress) }
    }
    case 'downloaded':
      if (update.error) return { ...base, action: 'install', ...gateFailure(update) }
      return installing
        ? { ...base, action: null, label: '正在重启安装…' }
        : { ...base, action: 'install', label: '立即更新' }
    case 'error':
      // 检查或下载失败后，electron-updater 已经不在「可下载」状态：从检查重新来，找到后
      // 那层提示会接着自动下载。
      return { ...base, action: 'check', ...gateFailure(update) }
  }
}

/**
 * 失败时门里的标题、按钮和原因与更新页、首页气泡说同一套话：标题和按钮都读
 * updateFailureLabel，原因句是主进程那一句。主进程的原因句只说「发生了什么、点哪颗
 * 三处都有的按钮」，唯一要在门里改口的是开机检查超时——那句安慰客户「不影响现在使用」，
 * 可门正把他挡在外面。
 */
function gateFailure(update: GateSnapshot): Pick<RequiredUpdateGateState, 'label' | 'failure' | 'failureTitle'> {
  const labels = updateFailureLabel(update.failedStep)
  const failure = update.error?.code === 'STARTUP_UPDATE_TIMEOUT'
    ? '网络有点慢，这次没来得及查完有没有新版本。点「重试」再查一次。'
    : update.error?.message || '更新没有完成，没认出是哪一类问题，原因已经记下来了。再试一次；还不行请找客服。'
  return { label: labels.retry, failure, failureTitle: labels.title }
}

/** 主按钮点过之后，状态走到下一步要不要替用户接着做（下载完接着装）。 */
export function requiredUpdateFollowUp(update: GateSnapshot | null | undefined): Exclude<RequiredUpdateAction, 'check'> | null {
  if (!update || update.error) return null
  // 空间不够时不替他接着点：再量一次结果多半一样，等他清出空间自己点「再试一次」。
  if (update.phase === 'available') return update.diskShortfall ? null : 'download'
  if (update.phase === 'downloaded') return 'install'
  return null
}
