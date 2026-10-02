/**
 * Mac 上一键装桌面端没装成时，客户看到的那句话。
 *
 * 主进程（macos-desktop-app-installer.ts）照这里拼，渲染层（operation-error.ts）照这里
 * 认出这一类、配上「看安装指南」按钮：两边共用一份字面量，改了一边另一边不会认不出来。
 * 原因原话（HTTP 状态、退出码之类）不进这句话，挂在错误的 detail 上进运行日志。
 *
 * 这个模块同时给主进程和渲染层用，所以和 network-failure.ts 一样不许引 Node（I6）。
 */

export function macosDesktopDownloadFailedMessage(name: string): string {
  return `${name} 没下载下来，请检查网络后再点一次「安装」。`
}

export const macosDesktopNotOfficialMessage = '下载下来的安装包不是官方原版，已经删掉，没有安装。请稍后再点一次「安装」。'

export function macosDesktopSystemTooOldMessage(name: string, minimumVersion: string): string {
  return `${name} 需要 macOS ${minimumVersion} 或更新的系统，这台 Mac 装不了。`
}

/** applicationName 是「应用程序」里那个应用的名字（不带 .app），客户在访达里看到的就是它。 */
export function macosDesktopNameTakenMessage(applicationName: string): string {
  return `「应用程序」里已经有一个 ${applicationName}，但它不是官方原版。请先把它移到废纸篓，再点「安装」。`
}

export function macosDesktopInstallFailedMessage(name: string): string {
  return `${name} 没装好，请再点一次「安装」。`
}

export function isMacosDesktopSystemTooOld(message: string): boolean {
  return /需要 macOS [\d.]+ 或更新的系统，这台 Mac 装不了/.test(message)
}

/** 系统太旧那一句另归一类（重试救不了），不算在这里。 */
export function isMacosDesktopInstallFailure(message: string): boolean {
  return message.includes('没下载下来，请检查网络后再点一次「安装」')
    || message.includes(macosDesktopNotOfficialMessage)
    || message.includes('但它不是官方原版。请先把它移到废纸篓')
    || message.includes('没装好，请再点一次「安装」')
}
