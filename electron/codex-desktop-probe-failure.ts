// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Imports nothing on purpose: the renderer value-imports this file (registered in
// scripts/verify-renderer-boundary.test.cjs), so it must stay free of Node APIs (I6).

/**
 * Windows 上查 Codex 桌面端装没装（开始菜单、进程、Appx 三段那条合并脚本，和单查 Appx 那条）
 * 没查成时，主进程交出去的那句话以这两个名字开头，后面是英文摘要，有原话的再接上原话
 * （PowerShell 的报错、看不懂的输出）。
 *
 * 这句话要进日志（scan.completed、desktop.detection-failed），客服靠它看出是哪一步、怎么了；
 * 可它也是首页「检测失败」那行的来源。以前查包那段直接把中文写进去（「Windows Appx 探测返回
 * 数据格式无效」），渲染层见是中文就原样上屏（11-18 客户截图）；PowerShell 的报错跟着系统语言，
 * 中文系统上也是中文，同样会被原样端上去。所以界面认的是这个开头，不再看后面是不是中文：
 * 认出来就换成自己的话，原话只留在日志里。
 */
export const codexDesktopStatusProbeName = 'Codex desktop status probe'
export const codexDesktopPackageProbeName = 'Codex desktop package probe'

/**
 * 查包那段答了话、答的却不是认得的结果：空输出、不是 JSON、条目都不合格、脚本里没有的那种说法。
 * 11-18 客户那次就是这种，推测是微软商店正在更新 Codex 桌面端、安装位置一时读不到；界面对这一种
 * 说「可能正在更新，等一两分钟点重新检测」，别的（超时、PowerShell 报错）照旧说检测出了错。
 */
export const codexDesktopUnrecognizedProbeResult = 'unrecognized result'

/** 主进程拼出来的检测失败那句话是不是查 Codex 桌面端的探测写的（见上）。 */
export function isCodexDesktopProbeFailure(message: string): boolean {
  return message.startsWith(`${codexDesktopStatusProbeName}:`) || message.startsWith(`${codexDesktopPackageProbeName}:`)
}

/** 是不是查包那段答了看不懂的结果（codexDesktopUnrecognizedProbeResult）。 */
export function isCodexDesktopUnrecognizedProbeResult(message: string): boolean {
  return message.startsWith(`${codexDesktopPackageProbeName}: ${codexDesktopUnrecognizedProbeResult} (`)
}
