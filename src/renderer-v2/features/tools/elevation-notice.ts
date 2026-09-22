import type { PlatformCapabilities } from '../../../../electron/ipc-contract'

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
