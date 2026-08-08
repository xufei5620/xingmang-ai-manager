import { Check, CircleDot, LoaderCircle, TriangleAlert } from 'lucide-react'
import { isDetectionFailed } from '../../app-shared'
import type { ToolStatus } from '../../types'

export function SetupCheckItem({
  label,
  detail,
  status,
  loading,
}: {
  label: string
  detail: string
  status: ToolStatus | null
  loading: boolean
}) {
  const ready = Boolean(status?.installed && !status.tooOld && status.versionStatus !== 'unknown')
  // A detection failure must render distinctly from "not yet installed" —
  // the tool it names may already be present, so lumping it in with "待安装"
  // would misreport what actually happened (see RuntimeCell/StatusMark).
  const failed = Boolean(status && isDetectionFailed(status))
  return (
    <div className="setup-check-item">
      <div className={ready ? 'setup-check-icon ready' : loading ? 'setup-check-icon loading' : 'setup-check-icon'}>
        {ready
          ? <Check size={15} strokeWidth={3} />
          : loading ? <LoaderCircle size={16} className="spin" />
            : failed ? <TriangleAlert size={15} />
              : <CircleDot size={15} />}
      </div>
      <div>
        <strong>{label}</strong>
        <span title={detail}>{detail}</span>
      </div>
      <small>{ready ? '已就绪' : loading ? '处理中' : failed ? '检测失败' : status?.tooOld ? '需升级' : status ? '待安装' : '等待检测'}</small>
    </div>
  )
}
