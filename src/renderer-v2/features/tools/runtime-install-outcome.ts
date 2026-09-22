import type { NodeRuntimeInstallResult, PythonRuntimeInstallResult } from '../../../../electron/ipc-contract'
import { runtimeDisplayName, type ManagedRuntimeId } from './runtime-install-guide'

/**
 * 主进程装完 Node.js / Python 会带回两个标记（node-runtime.ts / python-runtime.ts）：
 * - systemRestartRequired：MSI 退出码 3010，Windows 要重启才算把这次安装做完；
 * - pathRefreshRequired：安装器改了系统 PATH，但已经开着的进程看不到。
 *
 * 以前首页和「安装卸载」页都把返回值扔了，一律说「运行环境已准备」，遇到 3010
 * 的机器接着装命令行工具才失败，用户不知道该先重启（第七批 5）。这里只负责把两个
 * 标记翻成一句话，要不要弹重启确认由调用方看 restartRequired。
 *
 * PATH 那一条不再让用户去重开什么（yoyo 2026-09-22：面向小白，少让他做决定）：
 * 本软件打开命令行工具时自己把 Node.js 与代装的 Python 目录补进 PATH
 * （command-runner.ts 的 defaultCommandPaths / fallbackCommandPaths），从本软件
 * 打开的工具不用重开任何东西。所以 pathRefreshRequired 在这里只是普通的「装好了」。
 */
export interface RuntimeInstallOutcome {
  readonly message: string
  readonly tone: 'ok' | 'warn'
  readonly restartRequired: boolean
}

export function describeRuntimeInstallOutcome(
  runtime: ManagedRuntimeId,
  result: NodeRuntimeInstallResult | PythonRuntimeInstallResult,
): RuntimeInstallOutcome {
  const name = runtimeDisplayName(runtime)
  if (result.action === 'unchanged') {
    return { message: `${name} 本来就装好了，不用重复安装。`, tone: 'ok', restartRequired: false }
  }
  if ('systemRestartRequired' in result && result.systemRestartRequired) {
    return { message: `${name} 装好了，重启电脑后就能用。`, tone: 'warn', restartRequired: true }
  }
  return { message: `${name} 装好了。`, tone: 'ok', restartRequired: false }
}
