import type { PlatformCapabilities, StoreAppLaunchBlock } from '../../../../electron/ipc-contract'

// 渲染层只许经 ipc-contract 取主进程类型（verify-renderer-boundary 的允许清单），
// 同 runtime-install-guide.ts。
type PlatformFamily = PlatformCapabilities['platform']
type InstallManagement = PlatformCapabilities['nodeRuntimeInstall']

/**
 * Windows 上只有这两处安装真的会弹管理员授权：Node.js 是机器级 MSI
 * （`electron/node-runtime.ts` 的 `elevation: 'uac'`），Codex 桌面端是 Appx
 * （`electron/codex-desktop-appx.ts` 的提权分支）。Python 按当前用户装
 * （`InstallAllUsers=0`），四个命令行工具走 npm，都不提权，所以都没有这句。
 *
 * 这句必须在点之前就看得见：一个突然跳出来的系统授权窗口，很多人第一反应是点
 * 「否」，然后才看到「已取消管理员授权」。公司和学校的电脑还会直接要另一个账号的
 * 密码——事先说一句，用户至少知道该去找谁。
 *
 * 注意这里说的不是「请用管理员身份运行本软件」：本软件自己始终以普通权限运行，
 * 提权只发生在这两个安装程序上。
 */
export type ElevatedInstallSubject = 'node' | 'codexDesktop'

export function elevatedInstallNotice(
  subject: ElevatedInstallSubject,
  platform: PlatformFamily | undefined,
  management: InstallManagement | undefined,
): string | null {
  if (platform !== 'windows' || management !== 'managed') return null
  const name = subject === 'node' ? 'Node.js' : 'Codex 桌面端'
  return `这一步需要管理员授权：点「安装」后 Windows 会弹一次授权窗口，请选「是」，${name} 才装得上；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。`
}

/**
 * 首页工具行只有一行小字的位置，塞不下上面那整句。短版只说「会弹授权窗口」，
 * 完整说明留给运行环境卡和「安装卸载」页。
 */
export function elevatedInstallShortNotice(
  subject: ElevatedInstallSubject,
  platform: PlatformFamily | undefined,
  management: InstallManagement | undefined,
): string | null {
  if (!elevatedInstallNotice(subject, platform, management)) return null
  return '安装时需要管理员授权，Windows 会弹一次授权窗口'
}

/**
 * 系统自带的 Administrator 账户、或关了「用户账户控制」的电脑上，Windows 常常不让
 * 打开从应用商店装的软件，Codex 桌面端就是。以前要等客户装完（商店那一路最长一刻钟）、
 * 打开失败再等将近一分钟才说（#658），所以在「安装」之前先说一句。只提醒，不拦安装：
 * 这种账户到底装不装得上没核过，装得上、打不开是推测。
 *
 * 判断在主进程（electron/windows-store-app-launch.ts），这里只管说什么；检查页那句
 * 长的在主进程 describeStoreAppLaunchBlock，渲染层拿不到主进程的值，有意各写一份。
 * 不出现 UAC、Appx、令牌这类词；「用户账户控制」是 Windows 设置里的原名，可以用。
 */
export function storeAppLaunchNotice(block: StoreAppLaunchBlock | null | undefined): string | null {
  if (block === 'builtInAdministrator') {
    return '这台电脑用的是 Windows 自带的「Administrator」账户，从微软商店装的软件（比如 Codex 桌面端）可能打不开。建议换一个普通账户登录电脑再装；也可以先用 Codex 命令行版。'
  }
  if (block === 'uacDisabled') {
    return '这台电脑关掉了 Windows 的「用户账户控制」，从微软商店装的软件（比如 Codex 桌面端）可能打不开。请联系客服帮你把它打开后再装；也可以先用 Codex 命令行版。'
  }
  return null
}

/** 首页工具行那一行小字的短版。 */
export function storeAppLaunchShortNotice(block: StoreAppLaunchBlock | null | undefined): string | null {
  if (block === 'builtInAdministrator') return '这台电脑用的是 Windows 自带的「Administrator」账户，装完可能打不开；建议换普通账户登录电脑，或先用 Codex 命令行版'
  if (block === 'uacDisabled') return '这台电脑关了「用户账户控制」，装完可能打不开；请先联系客服，或先用 Codex 命令行版'
  return null
}
