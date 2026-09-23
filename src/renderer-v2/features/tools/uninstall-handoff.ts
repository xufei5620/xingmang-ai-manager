import type { ToolUninstallResult } from '../../../../electron/ipc-contract'

export const uninstallHandOffMessage = '已打开卸载窗口，在那个窗口里卸载完，再回来点「重新检测」。'

/**
 * 本软件以管理员身份运行时，卸载会转交给一个普通权限的窗口去做（主进程回
 * `delegated`）。这是预料之中的一步，不是失败（全面检测 Q49）：以前首页把它当错误
 * 抛出去，弹红色的「操作没有完成」。这里只挑出这一种，给一句中性的提示；
 * 其余结果返回 null，由调用方照旧处理。
 */
export function uninstallHandOffNotice(result: ToolUninstallResult): string | null {
  return result.outcome === 'delegated' ? uninstallHandOffMessage : null
}
