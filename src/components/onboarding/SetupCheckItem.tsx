import { Check, CircleDot, LoaderCircle } from 'lucide-react'
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
  return (
    <div className="setup-check-item">
      <div className={ready ? 'setup-check-icon ready' : loading ? 'setup-check-icon loading' : 'setup-check-icon'}>
        {ready
          ? <Check size={15} strokeWidth={3} />
          : loading ? <LoaderCircle size={16} className="spin" /> : <CircleDot size={15} />}
      </div>
      <div>
        <strong>{label}</strong>
        <span title={detail}>{detail}</span>
      </div>
      <small>{ready ? '已就绪' : loading ? '处理中' : status?.tooOld ? '需升级' : status ? '待安装' : '等待检测'}</small>
    </div>
  )
}
