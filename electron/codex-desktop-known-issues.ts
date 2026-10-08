/**
 * Codex 桌面端的已知问题表（第十九批 7）。
 *
 * CLI 的已知问题在 cli-verified-versions.ts，那张表管得到安装（npm 可以钉版本）；
 * 桌面端从微软商店 / 镜像装，装哪一版不归我们定，商店也会自己把它更新掉，所以
 * 这里只给提示、不给「退回上一版」：退回去的版本商店几小时就换回来，镜像的上一版
 * 是哪一版我们也核不了。命中时首页那一行说一句、打开失败的提示框也说同一句，
 * 并把人引到 Codex 命令行版。
 *
 * 这个模块同时给主进程和渲染层用（渲染层靠 codexDesktopKnownIssueMarker 认出这一类、
 * 配上「改用 Codex 命令行版」按钮），所以和 network-failure.ts 一样不许引 Node。
 *
 * 维护：上游出了新版、真机核过能打开之后，下一版把对应那一行删掉。
 */

/**
 * 已知在一些电脑上打不开的版本。
 * 26.924.2738.0：Windows 上自己起不来（开始菜单直接点也报「由于超时时间已过」），
 * 上游 openai/codex #48946 #49070 等多份报告，2026-09-29 真机复现。
 */
export const codexDesktopKnownBrokenVersions: readonly string[] = ['26.924.2738.0']

/** 失败提示里那半句的固定字样；渲染层 operation-error.ts 按它归到 codexDesktopKnownIssue。 */
export const codexDesktopKnownIssueMarker = '已知在一些电脑上打不开'

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
  return `这一版（${version}）在一些电脑上打不开，是 Codex 自己的问题，等商店出新版会自动好。急用先用 Codex 命令行版。`
}

/** 打开失败时追加在「Codex 桌面端没有打开：……」后面的那句。 */
export function codexDesktopKnownIssueLaunchSentence(version: string): string {
  return `你装的这一版（${version}）${codexDesktopKnownIssueMarker}，是 Codex 自己的问题，不是星芒。`
    + '等微软商店出新版会自动好；急用先点「改用 Codex 命令行版」。'
}
