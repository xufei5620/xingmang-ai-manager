import type { ExternalClientStatus, ExternalToolId } from '../../../../electron/ipc-contract'
import { clientConnections } from '../../registry/clients'
import { officialAccountNames } from '../../registry/tools'
import { detectionFailureMessage, snapshotErrorMessage } from '../../business-common'
import type { WindowOs } from '../app/window-os'

const noExternalClients: ExternalClientStatus[] = []

/**
 * Linux 上星芒装不了也打不开这几个桌面客户端（主进程那边一律「不支持此系统」），
 * 列出来只是一排点不动的按钮，所以整行不列（Linux 版拆分 ⑩）。
 */
export function visibleExternalClients(os: WindowOs, statuses: ExternalClientStatus[]): ExternalClientStatus[] {
  return os === 'linux' ? noExternalClients : statuses
}

/** Presentation only: external clients never enter the provider/configuration ToolId union. */
export function presentExternalClients(statuses: ExternalClientStatus[]) {
  return clientConnections.flatMap((definition) => {
    const status = statuses.find((entry) => entry.tool === definition.id)
    if (!status) return []
    // Claude Desktop 选了官方登录：用的是客户自己的 Claude 账号，能直接打开，不是没连上。
    const official = status.officialAccount === true && !status.configurationError
    const ready = official || (!status.configurationError && (status.configurationReady ?? (status.configured || status.configurationSource === 'other')))
    const configurationStatus: 'ready' | 'official' | 'unknownSource' | 'unconfigured' = !ready ? 'unconfigured' : official ? 'official'
      : status.configurationReady === true || status.configured ? 'ready' : 'unknownSource'
    const action = status.detectionError ? 'scan' : !status.installed ? 'install' : ready ? 'launch' : 'configure'
    const version = status.version ? `v${status.version.replace(/^v/, '')}` : '版本暂未识别'
    return [{ ...definition, status, ready, configurationStatus, action,
      disabled: action === 'install' ? !status.installSupported : action === 'launch' ? !status.launchSupported : false,
      detail: detectionFailureMessage(status.detectionError) ?? snapshotErrorMessage(status.configurationError) ?? (!status.installed ? status.installHint ?? definition.vendor
        : official ? [officialAccountNames.claude, version, status.running ? '运行中' : null].filter(Boolean).join(' · ')
        : [version, status.running ? '运行中' : null,
          // 换了线路、客户端开着这次没换成（第四十三批 A）：这时摆模型名，客户看不出这一行还连着原来那条。
          status.running && status.routePending ? status.routeRecheck ? '还开着，完全退出后会自动换到当前线路' : '连接线路暂未改动，完全退出后点「重新检测」'
            : status.model ?? (status.tool === 'claudeDesktop' && status.configurationReady ? '自动获取模型'
              : status.configurationSource === 'other' ? status.configurationReady === false ? '第三方推理配置待完善' : '已有第三方配置' : null)].filter(Boolean).join(' · ')),
    }]
  })
}

/** 这一行连好了没有，和首页卡片同一个认法：配置弹窗的标题靠它分「连接 X」还是「X 配置」。 */
export function externalClientReady(statuses: ExternalClientStatus[], tool: ExternalToolId): boolean {
  return presentExternalClients(statuses).find((client) => client.id === tool)?.ready ?? false
}
