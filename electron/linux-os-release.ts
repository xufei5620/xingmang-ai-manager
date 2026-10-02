import fs from 'node:fs'
import { readBoundedUtf8File } from './bounded-file'

/**
 * Linux 客户报问题时，客服要先分清是 Ubuntu 还是统信、X11 还是 Wayland、x64 还是 ARM，
 * 而小白答不上来。`os.release()` 在 Linux 上只是内核版本号（6.8.0-45-generic），看了等于
 * 没看。这里读系统自己写的 /etc/os-release，给检查页、「复制给客服」和启动日志用。
 *
 * 文件内容来自系统，但仍按不可信文本处理：只留字母、数字、空格和少数标点，截短，
 * 出现在界面上和日志里的就只可能是一个系统名字。
 */
export const osReleasePaths = ['/etc/os-release', '/usr/lib/os-release'] as const
const osReleaseMaxBytes = 8 * 1024
const systemNameMaxLength = 48

/** os-release(5)：KEY=value，值可以用单引号或双引号括起来，双引号里 \" \\ \$ \` 是转义。 */
export function parseOsRelease(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
    else if (value.length >= 2 && value.startsWith('\'') && value.endsWith('\'')) value = value.slice(1, -1)
    if (!fields.has(match[1])) fields.set(match[1], value)
  }
  return fields
}

function sanitizeSystemName(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N} ._()/+-]/gu, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > systemNameMaxLength ? cleaned.slice(0, systemNameMaxLength).trim() : cleaned
}

/** 「Ubuntu 24.04.1 LTS」「Debian GNU/Linux 12 (bookworm)」；什么都认不出返回 null。 */
export function linuxSystemName(fields: ReadonlyMap<string, string>): string | null {
  const pretty = fields.get('PRETTY_NAME')
  const composed = [fields.get('NAME'), fields.get('VERSION') ?? fields.get('VERSION_ID')].filter(Boolean).join(' ')
  for (const candidate of [pretty, composed]) {
    if (!candidate) continue
    const name = sanitizeSystemName(candidate)
    if (name) return name
  }
  return null
}

/**
 * /etc/os-release 在 Ubuntu、Debian 上是指向 /usr/lib/os-release 的符号链接，有界读取
 * 本身不跟链接，所以先解析到实际文件再读。两处都读不到返回 null。
 */
export async function readLinuxSystemName(
  read: typeof readBoundedUtf8File = readBoundedUtf8File,
  resolve: (filePath: string) => Promise<string> = (filePath) => fs.promises.realpath(filePath),
): Promise<string | null> {
  for (const candidate of osReleasePaths) {
    try {
      const resolved = await resolve(candidate)
      const name = linuxSystemName(parseOsRelease(await read(resolved, osReleaseMaxBytes, '系统版本信息')))
      if (name) return name
    } catch {
      // Missing or unreadable: try the next location.
    }
  }
  return null
}

function sessionToken(value: string | undefined): string | null {
  const token = value?.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 40)
  return token || null
}

/**
 * 启动日志里那几项：桌面（GNOME / KDE / Deepin / UKUI…）和显示方式（x11 / wayland）。
 * 只有名字，没有路径、账号名。
 */
export function describeLinuxDesktopSession(env: Readonly<Record<string, string | undefined>>): { desktop: string | null; sessionType: string | null } {
  return {
    desktop: sessionToken(env.XDG_CURRENT_DESKTOP ?? env.DESKTOP_SESSION),
    sessionType: sessionToken(env.XDG_SESSION_TYPE ?? (env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : undefined)),
  }
}
