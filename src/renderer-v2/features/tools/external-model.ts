import type { ExternalClientStatus } from '../../../../electron/ipc-contract'
import { clientConnections } from '../../registry/clients'
import { snapshotErrorMessage } from '../../business-common'

/** Presentation only: external clients never enter the provider/configuration ToolId union. */
export function presentExternalClients(statuses: ExternalClientStatus[]) {
  return clientConnections.flatMap((definition) => {
    const status = statuses.find((entry) => entry.tool === definition.id)
    if (!status) return []
    const ready = !status.configurationError && (status.configurationReady ?? (status.configured || status.configurationSource === 'other'))
    const configurationStatus: 'ready' | 'unknownSource' | 'unconfigured' = !ready ? 'unconfigured'
      : status.configurationReady === true || status.configured ? 'ready' : 'unknownSource'
    const action = status.detectionError ? 'scan' : !status.installed ? 'install' : ready ? 'launch' : 'configure'
    return [{ ...definition, status, ready, configurationStatus, action,
      disabled: action === 'install' ? !status.installSupported : action === 'launch' ? !status.launchSupported : false,
      detail: snapshotErrorMessage(status.detectionError) ?? snapshotErrorMessage(status.configurationError) ?? (!status.installed ? status.installHint ?? definition.vendor
        : [status.version ? `v${status.version.replace(/^v/, '')}` : '版本暂未识别', status.running ? '运行中' : null,
          status.model ?? (status.tool === 'claudeDesktop' && status.configurationReady ? '自动获取模型'
            : status.configurationSource === 'other' ? status.configurationReady === false ? '第三方推理配置待完善' : '已有第三方配置' : null)].filter(Boolean).join(' · ')),
    }]
  })
}
