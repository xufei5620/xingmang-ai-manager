/**
 * Windows 上 Claude Desktop 装不上时，客户看到的那句话。
 *
 * 一键安装有两路：先交给系统自带的安装组件（winget），不行再从 Claude 官网下离线
 * 安装包。两路都没装上时，把原话归成客户分得清的几种原因，每种一句大白话，配上
 * 「去官网下载」这个一直走得通的出口；原话照旧挂在错误上进运行日志，界面不出现。
 *
 * 这个模块同时给主进程和渲染层用（渲染层靠 claudeDesktopInstallFailedPrefix 认出
 * 这一类），所以和 codex-desktop-install-failure.ts 一样不许引 Node。
 */

/**
 * Claude 官网的下载页：首页「去官网下载」和错误框「去官网下载」打开的都是它。
 * main.ts 的外链白名单经 externalClientOfficialDownloadUrls 按全等匹配收录这一条（I12）。
 */
export const claudeDesktopDownloadPageUrl = 'https://claude.com/download'

/** 安装失败那句话的开头；渲染层 operation-error.ts 按它归到 claudeDesktopInstallFailed。 */
export const claudeDesktopInstallFailedPrefix = 'Claude Desktop 没装上'

/** 两路都试过时，原因前面那半句。电脑上本来就没有系统安装组件时不说它。 */
export const claudeDesktopBothRoutesFailedNotice = '系统自带的安装组件和 Claude 官网的离线安装包这次都没装上'

export type ClaudeDesktopInstallFailureReason = 'unsupported' | 'blocked' | 'damaged' | 'unreachable' | 'unknown'

export const claudeDesktopInstallFailureReasons: Readonly<Record<ClaudeDesktopInstallFailureReason, string>> = {
  unsupported: '这台电脑的 Windows 版本太旧，装不了 Claude Desktop。',
  blocked: '这台电脑不让装（Windows 拒绝了这次安装）。',
  damaged: '下载下来的安装包不完整或不是官方原版，已经删掉了。',
  unreachable: 'Claude 官网这会儿连不上。',
  unknown: '没查出是哪一步出了问题，经过已经记进日志。',
}

/**
 * 顺序同 codex-desktop-install-failure.ts：Windows 那一步（Add-AppxPackage）的报错里
 * 常带着签名、包身份这些词，先认它，才不会被当成「安装包坏了」叫客户反复重下。
 */
const rules: ReadonlyArray<{ reason: Exclude<ClaudeDesktopInstallFailureReason, 'unknown'>; test: RegExp }> = [
  { reason: 'unsupported', test: /0x80073cfd|requires OS version|OS 版本[^。；]{0,40}(或更高|以上)/i },
  { reason: 'blocked', test: /Add-AppxPackage|管理员安装失败|应用部署|0x80073[cd][0-9a-f]{2}|授权使用了不同的 Windows 账号/i },
  { reason: 'damaged', test: /不完整|不是官方原版|签名|身份|发布者|版本号无效|大小无效|安全上限|超过声明|AppxManifest|发生变化|不是 MSIX|Content-Type|SHA-256/i },
  { reason: 'unreachable', test: /HTTP \d{3}|超时|连接|连不上|重定向|没有返回|fetch failed|network|socket|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_[A-Z_]+/i },
]

export function classifyClaudeDesktopInstallFailure(detail: string): ClaudeDesktopInstallFailureReason {
  return rules.find((rule) => rule.test.test(detail))?.reason ?? 'unknown'
}

/**
 * 这几句本来就是写给客户看的，各有自己的下一步（重新授权、找管理员账号、清磁盘），
 * 套上「没装上」反而把那一步盖掉，所以原样放行。
 */
export function isPlainClaudeDesktopInstallMessage(message: string): boolean {
  return /磁盘|已取消管理员授权|未获得管理员权限|安装已取消/.test(message)
}

export function buildClaudeDesktopInstallFailureMessage(
  reason: ClaudeDesktopInstallFailureReason,
  context: { wingetTried: boolean },
): string {
  const routes = context.wingetTried ? `${claudeDesktopBothRoutesFailedNotice}，` : ''
  return `${claudeDesktopInstallFailedPrefix}：${routes}${claudeDesktopInstallFailureReasons[reason]}`
}

export function isClaudeDesktopInstallFailureMessage(message: string): boolean {
  return message.includes(`${claudeDesktopInstallFailedPrefix}：`)
}
