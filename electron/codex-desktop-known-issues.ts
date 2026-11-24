// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * Codex 桌面端的已知问题表（第十九批 7）。
 *
 * CLI 的已知问题在 cli-verified-versions.ts，那张表管得到安装（npm 可以钉版本）；
 * 桌面端从微软商店 / 镜像装，装哪一版不归我们定，商店也会自己把它更新掉，所以
 * 这里只给提示、不给「退回上一版」：退回去的版本商店几小时就换回来，镜像的上一版
 * 是哪一版我们也核不了。命中时首页那一行说一句、打开失败的提示框也说同一句，
 * 并把人引到 Codex CLI。
 *
 * 这个模块同时给主进程和渲染层用（渲染层靠 codexDesktopKnownIssueMarker 认出这一类、
 * 配上「改用 Codex CLI」按钮），所以和 network-failure.ts 一样不许引 Node。
 *
 * 维护：上游出了新版、真机核过能打开之后，下一版把对应那一行删掉。
 */

/**
 * 已知在部分电脑上无法打开的版本。
 * 26.924.2738.0：Windows 上自己起不来（开始菜单直接点也报「由于超时时间已过」），
 * 上游 openai/codex #48946 #49070 等多份报告，2026-09-29 真机复现。
 */
export const codexDesktopKnownBrokenVersions: readonly string[] = ['26.924.2738.0']

/** 失败提示里那半句的固定字样；渲染层 operation-error.ts 按它归到 codexDesktopKnownIssue。 */
export const codexDesktopKnownIssueMarker = '已知在部分电脑上无法打开'

// 商店包版本是四段（26.924.2738.0），应用自己的 package.json 可能只写三段，
// 末尾的 .0 不影响是不是同一版。
function normalizeVersion(version: string): string {
  const parts = version.trim().replace(/^v/i, '').split('.')
  while (parts.length > 1 && /^0+$/.test(parts[parts.length - 1])) parts.pop()
  return parts.map((part) => part.replace(/^0+(?=\d)/, '')).join('.')
}

/**
 * 装着的是不是已知打不开的那一版；是就返回表里那个版本号（给客户看的就是它），
 * 不是或读不出版本时 null。可以同时传商店包版本和应用版本，任一命中就算。
 */
export function resolveCodexDesktopKnownIssue(
  versions: ReadonlyArray<string | null | undefined>,
  list: readonly string[] = codexDesktopKnownBrokenVersions,
): string | null {
  const installed = versions.filter((version): version is string => typeof version === 'string' && version.trim() !== '')
    .map(normalizeVersion)
  if (!installed.length) return null
  return list.find((entry) => installed.includes(normalizeVersion(entry))) ?? null
}

/** 首页 Codex 桌面端那一行的小字。 */
export function codexDesktopKnownIssueNotice(version: string): string {
  return `该版本（${version}）在部分电脑上无法打开，属于 Codex 自身问题，商店发布新版本后将自动恢复。如急需使用，可先使用 Codex CLI。`
}

/** 打开失败时追加在「Codex 桌面端未能打开：……」后面的那句。 */
export function codexDesktopKnownIssueLaunchSentence(version: string): string {
  return `您安装的版本（${version}）${codexDesktopKnownIssueMarker}，属于 Codex 自身问题，并非星芒的问题。`
    + '微软商店发布新版本后将自动恢复；如急需使用，请点击「改用 Codex CLI」。'
}

/**
 * 另一种已知打不开：不是哪一版的毛病，是 Windows 那边激活坏了。Codex 装得好好的，Windows 的
 * 应用激活接口却回「这个应用没装」（0x80270254），一直没起来。2026-11-21 一台 Win10 家庭版
 * 19045.6456 的排查记录里，重新注册、覆盖安装、完整重装都回「成功」，照样打不开，重启 Windows
 * 才好；openai/codex #57691（Win10 专业版，同一个系统版本号）也是重启才好。所以这一类的失败框
 * 第一颗按钮是「立即重启」，不给「重置 Codex」：清掉登录也救不了它。
 *
 * 渲染层按这半句归到 codexDesktopActivationBroken，所以字面量只在这里写一次。
 */
export const codexDesktopActivationBrokenMarker = 'Codex 已安装，但 Windows 未能启动它'

/** 跟在「Codex 桌面端未能打开：」后面的那句（yoyo 2026-11-21 批的字，「重启框改」）。 */
export function codexDesktopActivationBrokenSentence(waitedSeconds?: number): string {
  const waited = waitedSeconds === undefined
    ? '未检测到 Codex 运行'
    : `等待 ${waitedSeconds} 秒仍未检测到 Codex 运行`
  return `${codexDesktopActivationBrokenMarker}，${waited}。重启电脑后通常可以恢复。`
}

/**
 * 第三种：Windows 打开商店签名的 Codex 前要联网向微软核对使用许可，网络不通或超时，激活接口回
 * WinINet 的网络错误码（0x80072EE2 等，见 codex-desktop-cdp.ts 的 isCodexDesktopActivationNetworkFailure），
 * 进程根本没建出来，开始菜单直接点也一样。2026-11-23 一台 Win11 家庭版 26H2 26300.10075：网络断着时
 * 回 0x80072EE2，网络一好同一个包就能开。重置、重启、重装都救不了它，所以这一类的失败框只给「重试」
 * 「检查网络」「联系客服」。
 *
 * 渲染层按这半句归到 codexDesktopActivationOffline，所以字面量只在这里写一次。
 */
export const codexDesktopActivationOfflineMarker = 'Windows 打开 Codex 前需要联网向微软验证'

/** 跟在「Codex 桌面端未能打开：」后面的那句。 */
export function codexDesktopActivationOfflineSentence(waitedSeconds?: number): string {
  const waited = waitedSeconds === undefined
    ? '未检测到 Codex 运行'
    : `等待 ${waitedSeconds} 秒仍未检测到 Codex 运行`
  return `${codexDesktopActivationOfflineMarker}，本次验证超时，${waited}。网络恢复后重新打开即可。`
}

/**
 * 第四种：Codex 第一次在这台电脑上启动，要借 Windows 更新服务向微软完成验证，而客户（或替他装机的人）
 * 把 Windows 更新关了，服务起不来。2026-11-23 一台 Win11 家庭版 21H2 22000.2245：激活回 0x800705B4，
 * 放开更新 5 秒内 Codex 就起来了，再关回去、重启以后照样能开（见 windows-update-service-state.ts）。
 * 重置、重启、重装都救不了，出口是临时开一下更新，所以这一类的失败框只给「重试」「联系客服」。
 *
 * 渲染层按这半句归到 codexDesktopWindowsUpdateBlocked，所以字面量只在这里写一次。
 */
export const codexDesktopWindowsUpdateBlockedMarker = '本机的 Windows 更新服务无法启动'

/** 跟在「Codex 桌面端未能打开：」后面的那句（yoyo 2026-11-24 批的字，「更新框改」）。 */
export function codexDesktopWindowsUpdateBlockedSentence(waitedSeconds?: number): string {
  const waited = waitedSeconds === undefined
    ? '未检测到 Codex 运行'
    : `等待 ${waitedSeconds} 秒仍未检测到 Codex 运行`
  return `${codexDesktopWindowsUpdateBlockedMarker}，Codex 首次启动所需的验证未能完成，${waited}。临时开启 Windows 更新并成功打开一次 Codex 后，可重新关闭更新。`
}
