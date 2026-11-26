import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { AccountSessionState } from '../../../../electron/ipc-contract'
import type { UsableSubscription } from '../../../../electron/subscription-summary'
import type { AccountSummary } from '../account/AccountOverview'
import { BalanceTierProvider } from '../../ui'
import { balanceTier, type BalanceRunway } from './balance-runway'
import type { AccountBalanceSnapshot, AccountBalanceStore } from './balance-store'
import type { ToolsApi } from './runtime-context'
import { useBalanceWatch } from './useActivityNotices'

/** 侧栏账号卡、状态栏和个人中心要的那几样钱数，跟首页说同一套。 */
export interface AccountMoney {
  /** 当前账号的余额快照；换账号那一下快照还是上一个账号的，按空的给。 */
  balanceState: AccountBalanceSnapshot
  /** 余额折成美元；没读到为 null。 */
  balanceAmount: number | null
  runway: BalanceRunway | null
  accountSummary: AccountSummary
}

const AccountMoneyContext = createContext<AccountMoney | null>(null)

interface AccountMoneyProviderProps {
  store: AccountBalanceStore
  toolsApi: ToolsApi
  session: AccountSessionState
  scope: string
  subscription: UsableSubscription | null
  subscriptionUnknown: boolean
  children: ReactNode
}

/**
 * 余额一刷新就要重算的钱数都在这里算（R8）。以前挂在界面根组件上，每分钟一次的余额刷新要把整个界面
 * 一百多个组件重画三遍，停在别的页面也一样。现在根组件把它套在外面：刷新时只有读这份钱数的地方重画，
 * children 是根组件那一次就画好的，原样留着。
 */
export function AccountMoneyProvider({ store, toolsApi, session, scope, subscription, subscriptionUnknown, children }: AccountMoneyProviderProps) {
  const balanceScope = session.authenticated ? scope : null
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const balanceState: AccountBalanceSnapshot = snapshot.scope === balanceScope
    ? snapshot
    : { scope: balanceScope, balance: null, loading: false, updatedAt: null, error: null, reads: 0, networkFailures: 0 }
  const { balanceAmount, runway, accountSummary } = useBalanceWatch({ toolsApi, session, scope, balanceState, subscription, subscriptionUnknown })
  return <AccountMoneyContext.Provider value={{ balanceState, balanceAmount, runway, accountSummary }}>
    <BalanceTierProvider value={balanceTier(balanceAmount, subscription, subscriptionUnknown)}>{children}</BalanceTierProvider>
  </AccountMoneyContext.Provider>
}

/** 外层没套 AccountMoneyProvider（组件测试、单独的页面夹具）时为 null。 */
export function useAccountMoney(): AccountMoney | null {
  return useContext(AccountMoneyContext)
}

/** 把钱数交给 children 去画：余额刷新时只有这一块跟着重画（R8）。外层没套时什么都不画。 */
export function AccountMoneyView({ children }: { children: (money: AccountMoney) => ReactNode }) {
  const money = useAccountMoney()
  return <>{money && children(money)}</>
}
