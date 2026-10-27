import { useEffect } from 'react'
import type { AccountSessionState, ExternalClientStatus } from '../../../../electron/ipc-contract'
import type { UsableSubscription } from '../../../../electron/subscription-summary'
import { accountSupports } from '../../account-context'
import { platformApi } from '../../platform-api'
import { presentTools, type ToolboxSnapshot } from '../tools/model'
import { inAppToolUpdates, pendingExternalUpdates, pendingToolUpdates, readAnnouncedToolUpdates, rememberAnnouncedToolUpdates, unannouncedToolUpdates, updateNoticeKey } from '../tools/update-notice'
import { buildBalanceRunway, useRunwayUsage } from './balance-runway'
import type { AccountBalanceSnapshot } from './balance-store'
import type { ToolsApi } from './runtime-context'

/** 首页、侧栏角标数的「有新版本」；开机检测完再汇总成一条系统通知。 */
/**
 * externalClients：Mac 上 Claude Desktop、OpenCode 也会有「可更新到 v…」，一起数、一起说。externalPending = 客户端那一轮
 * 真检测还没回来：通知等它回来再发，免得开机先说一次命令行工具、过几秒又为客户端再说一次。缺省 = 不等。
 */
export function useToolUpdateNotice(snapshot: ToolboxSnapshot | null, externalClients: readonly ExternalClientStatus[] = [], externalPending = false) {
  const externalUpdates = pendingExternalUpdates(externalClients)
  const toolUpdates = snapshot ? [...pendingToolUpdates(presentTools(snapshot)), ...externalUpdates] : []
  // 启动扫描完成后把「有新版本」汇总成一条系统通知。同一个工具同一个目标版本
  // 只说一次，抑制状态留在本机，所以下次启动不会再念一遍；工具更完或者上游又
  // 出了新版本，记录随之变化，才会再提醒。通知说「回到星芒就能逐个更新」，
  // 所以只算星芒更新得了的那几个（inAppToolUpdates），角标照旧数全部。
  const noticeUpdates = snapshot ? [...inAppToolUpdates(presentTools(snapshot)), ...externalUpdates] : []
  const toolUpdateKey = updateNoticeKey(noticeUpdates)
  useEffect(() => {
    // 开机先画出来的上次结果不算：那时说的「有新版本」可能早就更新过了。
    if (!snapshot || snapshot.system.cachedAt || externalPending) return
    if (unannouncedToolUpdates(noticeUpdates, readAnnouncedToolUpdates()).length > 0) {
      void platformApi()?.notifyActivity('cliUpdate', toolUpdateKey).catch(() => undefined)
    }
    rememberAnnouncedToolUpdates(noticeUpdates)
    // toolUpdateKey 已经把这一轮的工具与目标版本压成一个字符串，
    // 快照里别的字段变化（余额、运行环境）不该重新触发这段。
  }, [toolUpdateKey, Boolean(snapshot), Boolean(snapshot?.system.cachedAt), externalPending])
  return toolUpdates
}

interface BalanceWatchOptions {
  toolsApi: ToolsApi
  session: AccountSessionState
  scope: string
  balanceState: AccountBalanceSnapshot
  subscription: UsableSubscription | null
}

/**
 * 余额折成美元，算出还能用几天。余额跌破 5 美元、一小时里花得远超平时那两条系统通知挪到了
 * 主进程（electron/balance-alerts.ts）：窗口缩到托盘久了界面会被关掉，那时也得照样提醒。
 */
export function useBalanceWatch({ toolsApi, session, scope, balanceState, subscription }: BalanceWatchOptions) {
  const balance = balanceState.balance
  const balanceAmount = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  const supportsUsage = session.authenticated && accountSupports(session, 'supportsUsage')
  const runwayUsage = useRunwayUsage(toolsApi, supportsUsage ? scope : null, balanceState.updatedAt ?? undefined)
  const runway = session.authenticated && balance ? buildBalanceRunway({
    walletUsd: balanceAmount, subscription,
    weekUsageUsd: runwayUsage && balance.quotaPerUnit > 0 ? runwayUsage.weekQuota / balance.quotaPerUnit : null,
  }) : null
  // 账号概览和首页说同一套数：还能用几天、能扣的订阅、近 7 天花费（历史账号只有这个合计）。
  const accountSummary = { runway, subscription, weekUsageUsd: runwayUsage && balance && balance.quotaPerUnit > 0 ? runwayUsage.weekQuota / balance.quotaPerUnit : null }
  return { balanceAmount, runway, accountSummary }
}
