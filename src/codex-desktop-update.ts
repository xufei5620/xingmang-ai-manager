export type CodexDesktopUpdateKind = 'latest' | 'installable' | 'store-current' | 'unknown'

export interface CodexDesktopUpdateInput {
  updateState?: 'available' | 'latest' | 'unknown'
  mirrorUpdateAvailable?: boolean | null
}

/**
 * Official OpenAI's MSIX feed can sit ahead of both the Microsoft Store
 * rollout and the domestic sideload mirror. "available" then does not mean
 * this app can install anything, and after a Store update it reads as a
 * stale nag. Only treat a newer official build as actionable when the
 * mirror actually has a package newer than the installed one.
 */
export function codexDesktopUpdateKind(status: CodexDesktopUpdateInput): CodexDesktopUpdateKind {
  if (status.updateState === 'latest') return 'latest'
  if (status.updateState === 'available' && status.mirrorUpdateAvailable === true) return 'installable'
  if (status.updateState === 'available' && status.mirrorUpdateAvailable === false) return 'store-current'
  return 'unknown'
}

export function codexDesktopUpdateDetail(
  status: CodexDesktopUpdateInput & {
    version?: string | null
    latestVersion?: string | null
    updateError?: string | null
  },
): string {
  const kind = codexDesktopUpdateKind(status)
  if (kind === 'latest') return '已检查，当前最新'
  if (kind === 'installable') {
    return status.latestVersion ? `可更新至 ${status.latestVersion}` : '可更新'
  }
  if (kind === 'store-current') {
    return status.latestVersion
      ? `已是可安装最新版 · 官方 ${status.latestVersion} 国内尚未同步`
      : '已是可安装最新版'
  }
  return status.updateError || '更新状态未知'
}
