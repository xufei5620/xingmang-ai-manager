import os from 'node:os'
// Linux-only paths, spelled with posix semantics so the tests mean the same on
// the Windows CI shards that also run them.
import { posix as path } from 'node:path'
import { loginLaunchArgument } from './login-launch'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, removeSafeDataFile, writeAtomicSafeUtf8File } from './safe-local-data'

/**
 * Linux 的「开机自动启动」：Electron 在 Linux 上没有登录项（getLoginItemSettings 全是
 * false），各家桌面（GNOME、KDE、deepin、UKUI、Xfce）认的是同一个约定：在
 * `${XDG_CONFIG_HOME:-~/.config}/autostart/` 里放一个 .desktop 文件。
 *
 * 文件名和菜单项、安装目录用同一个英文名。只放这一份，关掉开关就删掉它；用户在系统
 * 「开机启动的应用」里停用时（Hidden=true 或 X-GNOME-Autostart-enabled=false），这里
 * 读出来是「登记了但没生效」，不替他改回来。
 */
export const linuxAutostartFileName = 'xingmang-ai-manager.desktop'
const linuxAutostartMaxBytes = 16 * 1024
const label = '开机启动项'

export interface LinuxAutostartState {
  requested: boolean
  enabled: boolean
}

/** XDG 规定相对路径一律当没设。 */
export function linuxAutostartDirectory(env: Readonly<Record<string, string | undefined>>, homeDirectory: string): string {
  const configured = env.XDG_CONFIG_HOME?.trim()
  const configHome = configured && path.isAbsolute(configured) ? configured : path.join(homeDirectory, '.config')
  return path.join(configHome, 'autostart')
}

// Desktop Entry Specification, "The Exec key": inside a quoted argument the
// characters " ` $ \ are escaped with a backslash, and a literal % is %%.
// The value then goes through the general string escaping, which doubles every
// backslash again. A line break or control character has no safe spelling at
// all, so such a path is refused rather than encoded.
export function quoteDesktopExecArgument(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('开机启动项的程序路径带有不能写进启动文件的字符')
  const quoted = `"${value.replace(/["`$\\]/g, (character) => `\\${character}`)}"`
  return quoted.replace(/%/g, '%%').replace(/\\/g, '\\\\')
}

export function buildLinuxAutostartEntry(executablePath: string): string {
  if (!path.isAbsolute(executablePath)) throw new Error('开机启动项的程序路径必须是绝对路径')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=星芒AI管理工具',
    'Comment=开机后自动打开星芒AI管理工具',
    // The flag is the only way the app can tell a login launch from the user
    // opening it (login-launch.ts); it then stays in the tray when there is one.
    `Exec=${quoteDesktopExecArgument(executablePath)} ${loginLaunchArgument}`,
    'Icon=xingmang-ai-manager',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

function desktopEntryValues(text: string): Map<string, string> {
  const values = new Map<string, string>()
  let inEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) { inEntry = line === '[Desktop Entry]'; continue }
    if (!inEntry) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!values.has(key)) values.set(key, line.slice(separator + 1).trim())
  }
  return values
}

/**
 * 读出来的那份文件现在管不管用。指向的不是这一份星芒（换过安装位置）也算没生效：
 * 开机拉起的会是别的程序，或者什么都拉不起来。
 */
export function inspectLinuxAutostartEntry(text: string | null, executablePath: string): LinuxAutostartState {
  if (text === null) return { requested: false, enabled: false }
  const values = desktopEntryValues(text)
  let expectedExec: string | null = null
  try { expectedExec = `${quoteDesktopExecArgument(executablePath)} ${loginLaunchArgument}` } catch { expectedExec = null }
  const enabled = values.get('Hidden')?.toLowerCase() !== 'true'
    && values.get('X-GNOME-Autostart-enabled')?.toLowerCase() !== 'false'
    && expectedExec !== null
    && values.get('Exec') === expectedExec
  return { requested: true, enabled }
}

export interface LinuxAutostart {
  inspect(): LinuxAutostartState
  set(enabled: boolean): Promise<void>
}

export interface LinuxAutostartOptions {
  env: Readonly<Record<string, string | undefined>>
  executablePath: string
  homeDirectory?: string
}

/**
 * 读写都走 safe-local-data（I8）：~/.config/autostart 是用户可写目录，里面的符号链接、
 * 硬链接能把这次写入引到别处去。读不出来（被换成了链接、坏了）按「没登记」报，
 * 打开开关时写入会照样拒绝那种文件。
 */
export function createLinuxAutostart(options: LinuxAutostartOptions): LinuxAutostart {
  const directory = linuxAutostartDirectory(options.env, options.homeDirectory ?? os.homedir())
  const filePath = path.join(directory, linuxAutostartFileName)
  return {
    inspect() {
      let text: string | null = null
      try { text = readSafeUtf8FileSync(filePath, label, linuxAutostartMaxBytes) } catch { text = null }
      return inspectLinuxAutostartEntry(text, options.executablePath)
    },
    async set(enabled) {
      if (!enabled) {
        await removeSafeDataFile(filePath, label)
        return
      }
      const entry = buildLinuxAutostartEntry(options.executablePath)
      ensureSafeDataDirectory(directory, label)
      await writeAtomicSafeUtf8File(filePath, entry, label)
    },
  }
}
