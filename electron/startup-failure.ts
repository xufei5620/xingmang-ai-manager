import { redactHomeDirectory, redactStartupSecrets } from './startup-log'
import { startupFailureMessage } from './window-presentation'

/**
 * 启动出错时给小白看的那几句话。以前弹框直接照搬 `error.message`：用户看到的是
 * `ENOSPC: no space left on device, open 'C:\Users\张三\AppData\…'`，英文、还带着
 * Windows 用户名，点「确定」软件就退了。现在按原因换成大白话，原文只在用户
 * 点「复制错误信息」时才出去，而且先抹掉用户目录与密钥样式的片段（I13）。
 */

export type StorageFailureKind = 'disk-full' | 'blocked'
export type StartupFailureKind = StorageFailureKind | 'incomplete' | 'other'

const diskFullCodes = new Set(['ENOSPC', 'EDQUOT'])
// EBUSY / EPERM 在 Windows 上最常见的来源是杀毒软件或索引服务正开着这个文件。
const blockedCodes = new Set(['EACCES', 'EPERM', 'EBUSY'])

function errorCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: unknown = error
  // `cause` chains are followed a few levels deep: wrappers such as
  // safe-local-data rethrow with a Chinese message and keep the errno below.
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code.toUpperCase())
    current = (current as { cause?: unknown }).cause
  }
  return codes
}

/** 只认得出「磁盘满」和「被别的程序拦住」两种；其它读写错误返回 null。 */
export function classifyStorageFailure(error: unknown): StorageFailureKind | null {
  const codes = errorCodes(error)
  if (codes.some((code) => diskFullCodes.has(code))) return 'disk-full'
  if (codes.some((code) => blockedCodes.has(code))) return 'blocked'
  return null
}

export function classifyStartupFailure(error: unknown): StartupFailureKind {
  const storage = classifyStorageFailure(error)
  if (storage) return storage
  const codes = errorCodes(error)
  const message = error instanceof Error ? error.message : ''
  if (codes.includes('MODULE_NOT_FOUND') || /app\.asar/i.test(message)) return 'incomplete'
  return 'other'
}

/**
 * 「C 盘」这种说法只有在真知道盘符时才用；macOS、或者数据目录不在盘符路径上时
 * 统一说「磁盘」。
 */
export function dataDriveLabel(directory: string | null | undefined, platform: NodeJS.Platform): string {
  const letter = dataDriveLetter(directory, platform)
  return letter ? `${letter} 盘` : '磁盘'
}

export interface StartupFailureDialog {
  kind: StartupFailureKind
  title: string
  message: string
  detail: string
  /** 「复制错误信息」复制出去的内容：原文，但抹掉了用户目录和密钥样式的片段。 */
  copyText: string
}

export interface StartupFailureDialogOptions {
  platform: NodeJS.Platform
  homeDirectory: string
  /** `app.getPath('userData')`，用来说清是哪个盘满了。 */
  dataDirectory?: string | null
  appVersion?: string | null
}

export function buildStartupFailureDialog(error: unknown, options: StartupFailureDialogOptions): StartupFailureDialog {
  const kind = classifyStartupFailure(error)
  const drive = dataDriveLabel(options.dataDirectory, options.platform)
  const message = kind === 'disk-full'
    ? `${drive}空间不够了，软件没法保存设置。请先清理一下${drive}（比如清空回收站、删掉不用的大文件），再重新打开。`
    : kind === 'blocked'
      ? '软件的文件被别的程序（常见是杀毒软件）拦住了。请把星芒AI管理工具加进杀毒软件的信任名单，再重新打开。'
      : kind === 'incomplete'
        ? '软件文件不完整，请重新下载安装包安装一遍。你的登录和设置不会丢。'
        : '软件启动时出了点问题，可以先重新打开试一次。'
  const original = redactStartupSecrets(redactHomeDirectory(startupFailureMessage(error, options.platform), options.homeDirectory))
  const version = options.appVersion ? `星芒AI管理工具 ${options.appVersion}\n` : ''
  return {
    kind,
    title: '星芒AI管理工具打不开',
    message,
    detail: '还是打不开的话，点「复制错误信息」发给客服，我们帮你看。',
    copyText: `${version}启动失败：${original}`,
  }
}

/** 只取盘符字母交给界面（「C 盘」）；取不到就不给，界面改说「磁盘」。路径其余部分不出主进程。 */
export function dataDriveLetter(directory: string | null | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined
  const match = /^([A-Za-z]):/.exec(directory?.trim() ?? '')
  return match ? match[1].toUpperCase() : undefined
}
