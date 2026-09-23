import { Wrench } from 'lucide-react'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import { Notice } from '../../ui'

type ServiceMaintenance = NonNullable<UpdateSnapshot['serviceMaintenance']>

/**
 * 维护期间最常见的误会是「我的 Key 坏了」「我被登出了」：请求一个接一个失败，
 * 用户就去重登、重写配置、找客服。所以这条提示除了发布者那句话，还固定补一句
 * 「不是你这边的问题、什么都不用改」。文案不提站点名（双站点对用户无感）。
 */
export function maintenanceNoticeBody(maintenance: ServiceMaintenance): string {
  const reassurance = '这不是你这边的问题，不用重新登录，也不用改任何设置，维护结束后会自动恢复。'
  return maintenance.message
    ? `${maintenance.message} ${reassurance}`
    : `维护期间登录、余额和工具连接可能会失败。${reassurance}`
}

/** 同一条维护提示关掉之后，发布者换了说法才再出现。 */
export function maintenanceNoticeKey(maintenance: ServiceMaintenance | null | undefined): string | null {
  return maintenance ? `maintenance:${maintenance.message ?? ''}` : null
}

export function MaintenanceNotice({ maintenance, onDismiss, testId = 'service-maintenance-notice' }: {
  maintenance: ServiceMaintenance
  onDismiss?: () => void
  testId?: string
}) {
  return <Notice tone="warn" icon={Wrench} title="服务正在维护" body={maintenanceNoticeBody(maintenance)} onDismiss={onDismiss} testId={testId} />
}
