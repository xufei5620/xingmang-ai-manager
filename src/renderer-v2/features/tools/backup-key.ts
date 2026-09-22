import type { ConfigBackupSummary } from '../../../../electron/ipc-contract'

export interface BackupKeyView {
  tone: 'ok' | 'warn' | 'neutral'
  label: string
  /** 只有「不是当前账号的 Key」才给：恢复确认框里多拦一句。 */
  restoreWarning: string | null
}

/**
 * 备份里那把 Key 属于谁。主进程只给归属结论和账号名，从不给 Key 或摘要（I3）；
 * 旧备份没记（`unknown`）就不标，免得给用户一个说不准的结论。
 */
export function backupKeyView(backup: Pick<ConfigBackupSummary, 'keyOwnership' | 'keyAccountName'>): BackupKeyView | null {
  switch (backup.keyOwnership) {
    case 'current':
      return { tone: 'ok', label: '当前账号的 Key', restoreWarning: null }
    case 'other': {
      const name = backup.keyAccountName
      const lead = name ? `这份备份里是账号 ${name} 的 Key` : '这份备份里的 Key 不是当前账号的'
      return {
        tone: 'warn',
        label: name ? `账号 ${name} 的 Key` : '不是当前账号的 Key',
        restoreWarning: `${lead}。恢复后这个工具会改用那把 Key，用量不会记在当前账号上，那把 Key 失效了还会连不上。`,
      }
    }
    case 'none':
      return { tone: 'neutral', label: '没有 Key', restoreWarning: null }
    default:
      return null
  }
}
