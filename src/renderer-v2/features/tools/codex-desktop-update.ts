import type { DesktopAppStatus } from '../../../../electron/ipc-contract'
import type { WindowOs } from '../app/window-os'

type RunningProbe = Pick<DesktopAppStatus, 'running' | 'detectionFailed'>

/**
 * 点「更新」（或安装卸载页的「重新安装」）之前要不要先看 Codex 桌面端开没开（第三十二批 C）。
 * Windows 上主进程三条安装路线（商店、官网离线包、国内镜像）动手之前都先关掉它，5 秒没关掉
 * 就强行结束，正在进行的回答会被打断；商店那一路连商店有没有新版都还不知道就先关了。
 * Mac 上已经装好的那份星芒不碰（主进程直接说「已经装好了」），没装的那次也没有东西可关，都不用问。
 */
export function checksCodexDesktopBeforeUpdate(os: WindowOs, installed: boolean): boolean {
  return os === 'win' && installed
}

/**
 * 点下去那一刻它开没开。现问的那次（同「打开」那条路的 getCodexDesktopStatus）说开着就是开着；
 * 现问没问出来、或者这次检测没做完，按最近一次检测的结果算；那次也说不准，就当没开着，照旧直接装。
 */
export function codexDesktopRunningBeforeUpdate(live: RunningProbe | null, scanned: RunningProbe): boolean {
  if (live?.running) return true
  if (live && !live.detectionFailed) return false
  return scanned.running === true
}
