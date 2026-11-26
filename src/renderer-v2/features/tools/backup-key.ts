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
      return { tone: 'ok', label: '当前账号的密钥', restoreWarning: null }
    case 'other': {
      const name = backup.keyAccountName
      const lead = name ? `此备份中为账号 ${name} 的密钥` : '此备份中的密钥不属于当前账号'
      return {
        tone: 'warn',
        label: name ? `账号 ${name} 的密钥` : '不是当前账号的密钥',
        restoreWarning: `${lead}。恢复后该工具将改用该密钥，用量不计入当前账号，密钥失效后将无法连接。`,
      }
    }
    case 'none':
      return { tone: 'neutral', label: '无密钥', restoreWarning: null }
    default:
      return null
  }
}
