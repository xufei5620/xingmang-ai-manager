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
 *
 * 例外是星芒这次本身就带着管理员权限在跑（`elevated`，即 PlatformCapabilities.processElevated：
 * 自带 Administrator、关了 UAC、右键「以管理员身份运行」，都不是星芒自己要的）：装的时候 Windows
 * 不弹授权窗口，这句和下面的短版都不说，首页那段只去掉弹窗的话（已知19）。缺省 = 会弹（旧行为）。
 */
export type ElevatedInstallSubject = 'node' | 'codexDesktop'

export function elevatedInstallNotice(
  subject: ElevatedInstallSubject,
  platform: PlatformFamily | undefined,
  management: InstallManagement | undefined,
  elevated?: boolean,
): string | null {
  if (platform !== 'windows' || management !== 'managed' || elevated) return null
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
  elevated?: boolean,
): string | null {
  if (!elevatedInstallNotice(subject, platform, management, elevated)) return null
  return '安装时需要管理员授权，Windows 会弹一次授权窗口'
}

/**
 * 首页运行环境卡用的那一句。`elevatedInstallNotice` 是给「安装卸载」页的，那里的按钮就叫「安装」；
 * 首页这张卡上的按钮叫「准备 Node.js」，左边工具列表里又有一排「安装」，照抄「点「安装」后」
 * 客户分不清说的是哪颗（第二十七批 B）。装命令行工具时星芒也会顺带准备 Node.js，那时客户点的
 * 是工具那一行的「安装」，所以这里不说点哪颗，只说「准备 Node.js 时」会弹窗。
 *
 * 一个命令行工具都不在用（只装了 Codex 桌面端）时 Node.js 是可选的：不说「这一步需要」，
 * 先说清它是做什么的、一般不用单独点，弹窗那句照样提前说。
 *
 * 星芒本身带着管理员权限在跑（`elevated`）时不弹窗：可选的那段只去掉弹窗那半句，「一般不用单独点」
 * 照旧说，不然客户又不知道这颗要不要点；不是可选的那句从头到尾讲授权，整句不说（已知19）。
 */
export function homeNodeElevationNotice(
  platform: PlatformFamily | undefined,
  management: InstallManagement | undefined,
  optional: boolean,
  elevated?: boolean,
): string | null {
  if (!elevatedInstallNotice('node', platform, management)) return null
  const purpose = 'Node.js 是命令行工具需要的运行环境，装工具时会自动准备，一般不用单独点。'
  if (elevated) return optional ? purpose : null
  return optional
    ? `${purpose}准备时 Windows 会弹一次授权窗口，请选「是」；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。`
    : '这一步需要管理员授权：准备 Node.js 时 Windows 会弹一次授权窗口，请选「是」，Node.js 才装得上；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。'
}
