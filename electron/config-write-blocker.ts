// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Imports nothing on purpose: the renderer value-imports this file to recognise
// the reasons below (registered in scripts/verify-renderer-boundary.test.cjs),
// so it must stay free of Node APIs (I6).

/**
 * 写工具配置撞上「没权限」时，主进程查得出是哪一种的两种情况（D15，出处 权限和写失败.md PW-3、PW-4）：
 * Mac、Linux 上工具的设置文件夹被以前的管理员命令弄成了管理员的；Windows 上配置文件被客户自己设成了只读。
 * 以前一律说成「安全软件拦了、文件被别的程序占着」，叫人关窗口重试，这两种重试多少次都一样。
 *
 * 主进程只说是哪一种（下面这半句，取自 yoyo 批的那两句的开头，一字不改），整句和按钮由错误框照它认出来配
 * （registry/errors.ts 的 configAdminOwned、configReadOnly）。原来的英文原话挂在 cause 上进运行日志。
 */
export type ConfigWriteBlocker = 'adminOwned' | 'readOnly'

export const configWriteBlockerReasons: Readonly<Record<ConfigWriteBlocker, string>> = {
  adminOwned: '这个工具的设置文件夹归电脑管理员所有',
  readOnly: '这个文件被设成了只读',
}

const blockers: readonly ConfigWriteBlocker[] = ['adminOwned', 'readOnly']

/** 「这个文件被设成了只读（错误码 EPERM）」：错误码照 failure-wording.ts 的写法留在句尾，客服一眼看得出原来是哪个码。 */
export function configWriteBlockerMessage(blocker: ConfigWriteBlocker, code: string | null): string {
  return `${configWriteBlockerReasons[blocker]}${code ? `（错误码 ${code}）` : ''}`
}

/** 从包了几层的报错里（「改用当前账号没有完成：……已恢复到切换前的配置。」）认出是哪一种；都不是就是 null。 */
export function configWriteBlockerIn(message: string): ConfigWriteBlocker | null {
  return blockers.find((blocker) => message.includes(configWriteBlockerReasons[blocker])) ?? null
}
