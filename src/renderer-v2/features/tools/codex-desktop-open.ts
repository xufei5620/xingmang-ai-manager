import type { WindowOs } from '../app/window-os'

/**
 * 首页「打开」碰上 Codex 桌面端已经开着，要不要先弹「Codex 已在运行」让人选「打开窗口」还是
 * 「重启 Codex」。只有 Windows 能替用户重开；Mac 上主进程一律拒绝重启（codex-desktop-service.ts），
 * 那个框里唯一走得通的就是「打开窗口」，所以不再问，直接把现有窗口叫到前面（第二十九批 A）。
 */
export function offersCodexDesktopRestartOnOpen(os: WindowOs, running: boolean): boolean {
  return running && os === 'win'
}
