import type { PlatformInstallOutcome } from '../../../../electron/platform/contract'

/** 一次安装 / 更新结束后要不要发系统通知，发的话怎么说。 */
export interface InstallNoticePlan {
  /** 原本就装着、这次是更新。 */
  updating?: boolean
  /** 任务没抛错、但工具其实没装完（比如装完运行环境要先重启电脑）：这时不说「装好了」。 */
  unfinished?: () => boolean
}

export function resolveInstallNoticeOutcome(plan: InstallNoticePlan, succeeded: boolean): PlatformInstallOutcome | null {
  if (succeeded) {
    if (plan.unfinished?.()) return null
    return plan.updating ? 'updated' : 'installed'
  }
  return plan.updating ? 'updateFailed' : 'installFailed'
}

/**
 * 人就在窗口前看着时，界面上的进度和提示已经够了，再弹系统通知就是打扰。
 * 口径与公告那条一致：页面可见且窗口有焦点才算「在看」。
 */
export function isWindowInFront(view: Pick<Document, 'visibilityState' | 'hasFocus'> | undefined) {
  return Boolean(view && view.visibilityState === 'visible' && view.hasFocus())
}
