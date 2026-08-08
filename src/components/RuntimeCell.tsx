import { Terminal } from 'lucide-react'
import { isDetectionFailed, shortVersion } from '../app-shared'
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
  onRetry,
}: {
  label: string
  status: ToolStatus
  loading: boolean
  busyLabel?: string
  optional?: boolean
  actionLabel?: string
  onInstall: () => void
  onRetry: () => void
}) {
  const failed = isDetectionFailed(status)
  const blocked = status.tooOld === true || status.versionStatus === 'unknown'
  // A detection failure must not fall into the installable/blocked branch:
  // we do not actually know whether this tool is present, so offering an
  // install action here could reinstall over an already-working setup.
  const needsAction = !failed && (!status.installed || blocked)
  return (
    <div className="runtime-cell">
      <div className="runtime-icon"><Terminal size={19} /></div>
      <div className="runtime-copy">
        <div className="runtime-name">
          {label}
          {optional && <span className="optional-label">扩展</span>}
        </div>
        <span
          className={status.installed && !blocked && !failed ? 'runtime-version' : 'runtime-version is-missing'}
          title={failed ? status.detectionError ?? undefined : undefined}
        >
          {loading ? busyLabel ?? '检测中...'
            : failed ? '检测失败，点击重试'
              : !status.installed ? '未安装'
                : status.tooOld ? `版本过低 ${shortVersion(status.version)}`
                  : status.versionStatus === 'unknown' ? '版本无法识别'
                    : shortVersion(status.version)}
        </span>
      </div>
      <div className="runtime-action">
        <StatusMark installed={status.installed} loading={loading} failed={failed} />
        {!loading && failed && (
          <button className="inline-link" onClick={onRetry}>重试</button>
        )}
        {!loading && needsAction && (
          <button className="inline-link" onClick={onInstall}>{actionLabel}</button>
        )}
      </div>
    </div>
  )
}
