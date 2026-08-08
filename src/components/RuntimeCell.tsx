import { Terminal } from 'lucide-react'
import { shortVersion } from '../app-shared'
import type { ToolStatus } from '../types'
import { StatusMark } from './StatusMark'

export function RuntimeCell({
  label,
  status,
  loading,
  busyLabel,
  optional,
  actionLabel = '获取',
  onInstall,
}: {
  label: string
  status: ToolStatus
  loading: boolean
  busyLabel?: string
  optional?: boolean
  actionLabel?: string
  onInstall: () => void
}) {
  const blocked = status.tooOld === true || status.versionStatus === 'unknown'
  const needsAction = !status.installed || blocked
  return (
    <div className="runtime-cell">
      <div className="runtime-icon"><Terminal size={19} /></div>
      <div className="runtime-copy">
        <div className="runtime-name">
          {label}
          {optional && <span className="optional-label">扩展</span>}
        </div>
        <span className={status.installed && !blocked ? 'runtime-version' : 'runtime-version is-missing'}>
          {loading ? busyLabel ?? '检测中...'
            : !status.installed ? '未安装'
              : status.tooOld ? `版本过低 ${shortVersion(status.version)}`
                : status.versionStatus === 'unknown' ? '版本无法识别'
                  : shortVersion(status.version)}
        </span>
      </div>
      <div className="runtime-action">
        <StatusMark installed={status.installed} loading={loading} />
        {!loading && needsAction && (
          <button className="inline-link" onClick={onInstall}>{actionLabel}</button>
        )}
      </div>
    </div>
  )
}
