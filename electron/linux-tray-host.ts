import { execFile as nodeExecFile } from 'node:child_process'

/**
 * 这台 Linux 电脑的任务栏上有没有放托盘图标的地方。
 *
 * Electron 在 Linux 上把托盘图标交给 StatusNotifier（KDE、deepin、UKUI、Xfce、Ubuntu
 * 自带的 AppIndicator 扩展都认它）。可原版 GNOME（Debian 12、Fedora）没有这个接收方，
 * `new Tray()` 照样成功、`isDestroyed()` 照样是 false，图标却哪儿都看不见。这时关闭框
 * 默认「缩到托盘」，窗口一藏就找不回来，客户以为软件崩了。
 *
 * 所以只认一种证据：会话总线上有人占着 org.kde.StatusNotifierWatcher。只支持老式
 * XEmbed 托盘的面板（i3bar、LXDE）因此算「没有」，结果是关窗直接退出、开机自启照常
 * 弹窗，宁可这样也不让窗口凭空消失。
 */
export const statusNotifierWatcherName = 'org.kde.StatusNotifierWatcher'

export interface TrayHostProbeCommand {
  executable: string
  argv: readonly string[]
}

// Fixed absolute paths, never PATH (the I14 rule carried over to Linux): dbus-send
// ships with every desktop's D-Bus, gdbus with GLib. Both only ask the bus
// daemon a yes/no question; nothing from the user reaches argv (I1).
export const trayHostProbeCommands: readonly TrayHostProbeCommand[] = [
  {
    executable: '/usr/bin/dbus-send',
    argv: ['--session', '--print-reply=literal', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${statusNotifierWatcherName}`],
  },
  {
    executable: '/usr/bin/gdbus',
    argv: ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', statusNotifierWatcherName],
  },
]

/**
 * dbus-send 的 literal 输出是 `   boolean true`，gdbus 的是 `(true,)`。别的都不算数，
 * 返回 null，交给下一个探测程序或按「没有」处理。
 */
export function parseNameHasOwnerReply(output: string): boolean | null {
  const text = output.trim()
  const literal = /^boolean\s+(true|false)$/.exec(text)
  if (literal) return literal[1] === 'true'
  const tuple = /^\((true|false),\)$/.exec(text)
  if (tuple) return tuple[1] === 'true'
  return null
}

export type TrayHostExecFile = (executable: string, argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>

export interface LinuxTrayHostProbeOptions {
  env: NodeJS.ProcessEnv
  /** 只有能信任的程序才执行（归 root、别人改不了），由调用方按 linux-path-trust 判。 */
  isTrustedExecutable(executable: string): boolean
  execFile?: TrayHostExecFile
}

export const trayHostProbeTimeoutMs = 1_500

function runProbe(executable: string, argv: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile(executable, [...argv], { encoding: 'utf8', env, timeout: trayHostProbeTimeoutMs, maxBuffer: 4 * 1024, shell: false }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * 问一次会话总线。true＝有地方放托盘图标；false＝确定没有，或者问不出来（没有总线、
 * 两个程序都不可信或都不在）。从不抛错，启动不能被它挡住。
 */
export async function probeLinuxTrayHost(options: LinuxTrayHostProbeOptions): Promise<boolean> {
  const execFile = options.execFile ?? runProbe
  for (const command of trayHostProbeCommands) {
    let trusted = false
    try { trusted = options.isTrustedExecutable(command.executable) } catch { trusted = false }
    if (!trusted) continue
    try {
      const answer = parseNameHasOwnerReply(await execFile(command.executable, command.argv, options.env))
      if (answer !== null) return answer
    } catch {
      // No session bus, a timeout or a missing binary: try the other client.
    }
  }
  return false
}
