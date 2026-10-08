/**
 * Mac 上一键装桌面端没装成时，客户看到的那句话。
 *
 * 主进程（macos-desktop-app-installer.ts）照这里拼，渲染层（operation-error.ts）照这里
 * 认出这一类、配上「看安装指南」按钮：两边共用一份字面量，改了一边另一边不会认不出来。
 * 原因原话（HTTP 状态、退出码之类）不进这句话，挂在错误的 detail 上进运行日志。
 *
 * 这个模块同时给主进程和渲染层用，所以和 network-failure.ts 一样不许引 Node（I6）。
 */

/**
 * 主进程抛出的错误类名。Electron 把 IPC 拒绝写成「Error invoking remote method '通道':
 * 类名: 原话」，渲染层（business-common.tsx 的 ipcPrefixPattern）把紧跟通道名的类名
 * 剥掉才上屏；测试照它拼出 Electron 送来的那一串，核对错误框里只剩原话。
 */
export const macosDesktopInstallErrorName = 'MacosDesktopInstallError'

/** 中文名后面直接接话（「Codex 桌面端没装好」），英文名后面空一格（「OpenCode 没装好」）。 */
function subject(name: string): string {
  return /[A-Za-z0-9]$/.test(name) ? `${name} ` : name
}

export function macosDesktopDownloadFailedMessage(name: string): string {
  return `${subject(name)}没下载下来，请检查网络后再点一次「安装」。`
}

export const macosDesktopNotOfficialMessage = '下载下来的安装包不是官方原版，已经删掉，没有安装。请稍后再点一次「安装」。'

export function macosDesktopSystemTooOldMessage(name: string, minimumVersion: string): string {
  return `${subject(name)}需要 macOS ${minimumVersion} 或更新的系统，这台 Mac 装不了。`
}

/** applicationName 是「应用程序」里那个应用的名字（不带 .app），客户在访达里看到的就是它。 */
export function macosDesktopNameTakenMessage(applicationName: string): string {
  return `「应用程序」里已经有一个 ${applicationName}，但它不是官方原版。请先把它移到废纸篓，再点「安装」。`
}

/**
 * 「应用程序」里那个同名应用是 OpenAI 旧版的 ChatGPT 聊天程序（bundle id com.openai.chat）。
 * 新版 ChatGPT 就是 Codex 桌面端，用的是同一个名字；照「不是官方原版」那句说会吓到人，
 * 它其实是官方的，只是旧了。照样不替客户删，请他自己挪走。
 */
export const macosLegacyChatgptMessage = '「应用程序」里的 ChatGPT 是旧版聊天程序。新版 ChatGPT 就是 Codex 桌面端，名字相同，请先把旧版移到废纸篓，再点「安装」。'

export function macosDesktopInstallFailedMessage(name: string): string {
  return `${subject(name)}没装好，请再点一次「安装」。`
}

/**
 * 装到一半磁盘写满了（装之前已经查过空间，很少见）。和装之前就查出来的那句
 * （disk-space.ts 的 describeInsufficientDiskSpace）同一个说法，只是量不到还剩多少；
 * 渲染层按「磁盘空间不足」归到「磁盘空间不够」，不配「看安装指南」：自己下载也一样放不下。
 */
export function macosDesktopDiskFullMessage(name: string): string {
  return `${subject(name)}安装失败：安装目录所在磁盘空间不足，请先清理磁盘再试`
}

export function isMacosDesktopSystemTooOld(message: string): boolean {
  return /需要 macOS [\d.]+ 或更新的系统，这台 Mac 装不了/.test(message)
}

/** 系统太旧那一句另归一类（重试救不了），不算在这里。 */
export function isMacosDesktopInstallFailure(message: string): boolean {
  return message.includes('没下载下来，请检查网络后再点一次「安装」')
    || message.includes(macosDesktopNotOfficialMessage)
    || message.includes('但它不是官方原版。请先把它移到废纸篓')
    || message.includes(macosLegacyChatgptMessage)
    || message.includes('没装好，请再点一次「安装」')
}
