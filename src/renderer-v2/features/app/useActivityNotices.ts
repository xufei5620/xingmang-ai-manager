import { useEffect, useMemo, useRef } from 'react'
import type { AccountSessionState } from '../../../../electron/ipc-contract'
import type { UsableSubscription } from '../../../../electron/subscription-summary'
import { accountSupports } from '../../account-context'
import { platformApi } from '../../platform-api'
import { presentTools, type ToolboxSnapshot } from '../tools/model'
import { inAppToolUpdates, pendingToolUpdates, readAnnouncedToolUpdates, rememberAnnouncedToolUpdates, unannouncedToolUpdates, updateNoticeKey } from '../tools/update-notice'
import { buildBalanceRunway, useRunwayUsage } from './balance-runway'
import type { AccountBalanceSnapshot } from './balance-store'
import { createSpendSpikeWatch } from './spend-spike'
import type { ToolsApi } from './runtime-context'

/** 首页、侧栏角标数的「有新版本」；开机检测完再汇总成一条系统通知。 */
export function useToolUpdateNotice(snapshot: ToolboxSnapshot | null) {
  const toolUpdates = snapshot ? pendingToolUpdates(presentTools(snapshot)) : []
  // 启动扫描完成后把「有新版本」汇总成一条系统通知。同一个工具同一个目标版本
  // 只说一次，抑制状态留在本机，所以下次启动不会再念一遍；工具更完或者上游又
  // 出了新版本，记录随之变化，才会再提醒。通知说「回到星芒就能逐个更新」，
  // 所以只算星芒更新得了的那几个（inAppToolUpdates），角标照旧数全部。
  const noticeUpdates = snapshot ? inAppToolUpdates(presentTools(snapshot)) : []
  const toolUpdateKey = updateNoticeKey(noticeUpdates)
  useEffect(() => {
    // 开机先画出来的上次结果不算：那时说的「有新版本」可能早就更新过了。
    if (!snapshot || snapshot.system.cachedAt) return
    if (unannouncedToolUpdates(noticeUpdates, readAnnouncedToolUpdates()).length > 0) {
      void platformApi()?.notifyActivity('cliUpdate', toolUpdateKey).catch(() => undefined)
    }
    rememberAnnouncedToolUpdates(noticeUpdates)
    // toolUpdateKey 已经把这一轮的工具与目标版本压成一个字符串，
    // 快照里别的字段变化（余额、运行环境）不该重新触发这段。
  }, [toolUpdateKey, Boolean(snapshot), Boolean(snapshot?.system.cachedAt)])
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
 * 余额折成美元，算出还能用几天；余额跌破 5 美元、一小时里花得远超平时，各发一次系统通知
 * （开关在设置 → 通知，由主进程把关）。
 */
export function useBalanceWatch({ toolsApi, session, scope, balanceState, subscription }: BalanceWatchOptions) {
  const balance = balanceState.balance
  const balanceAmount = balance && balance.quotaPerUnit > 0 ? balance.quota / balance.quotaPerUnit : null
  const previousBalance = useRef<{ scope: string; value: number } | null>(null)
  useEffect(() => {
    if (balanceAmount === null) return
    const previous = previousBalance.current
    if (!subscription && previous?.scope === scope && previous.value >= 5 && balanceAmount < 5) {
      void platformApi()?.notifyActivity('balance', `balance:${session.account?.userId ?? 0}:${Date.now()}`).catch(() => undefined)
    }
    previousBalance.current = { scope, value: balanceAmount }
    // subscription 只用来挡这一次提醒，它自己读回来不该补发，所以不进依赖。
  }, [balanceAmount, scope, session.account?.userId])
  // 一小时里花掉的钱远超平时就提醒一次（第十五批 7）：只用余额每次刷新读到的数，
  // 掉得够多了才去读一次用量核账。开关在设置 → 通知「花费突然变多」，由主进程把关。
  const spendWatch = useMemo(() => createSpendSpikeWatch({
    readBaseline: () => toolsApi.spendBaseline(),
    notify: (eventKey, notice) => { void platformApi()?.notifyActivity('spend', eventKey, notice).catch(() => undefined) },
  }), [toolsApi])
  const supportsSpendCheck = session.authenticated && accountSupports(session, 'supportsUsage')
  const runwayUsage = useRunwayUsage(toolsApi, supportsSpendCheck ? scope : null, balanceState.updatedAt ?? undefined)
  const runway = session.authenticated && balance ? buildBalanceRunway({
    walletUsd: balanceAmount, subscription,
    weekUsageUsd: runwayUsage && balance.quotaPerUnit > 0 ? runwayUsage.weekQuota / balance.quotaPerUnit : null,
  }) : null
  // 账号概览和首页说同一套数：还能用几天、能扣的订阅、近 7 天花费（历史账号只有这个合计）。
  const accountSummary = { runway, subscription, weekUsageUsd: runwayUsage && balance && balance.quotaPerUnit > 0 ? runwayUsage.weekQuota / balance.quotaPerUnit : null }
  useEffect(() => {
    if (!balance || balanceState.updatedAt === null || !supportsSpendCheck) return
    void spendWatch.observe({ scope, account: String(session.account?.userId ?? 0), quota: balance.quota, quotaPerUnit: balance.quotaPerUnit, at: balanceState.updatedAt })
  }, [balanceState.updatedAt, balance, scope, session.account?.userId, supportsSpendCheck, spendWatch])
  return { balanceAmount, runway, accountSummary }
}
