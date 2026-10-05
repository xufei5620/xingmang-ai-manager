import { AccountPage } from './pages-account'
import { BackupsPage, ExtensionsPage, SessionsPage } from './pages-management'
import {
  FeedbackPage,
  HealthPage,
  MaintenancePage,
  SettingsPage,
  TutorialPage,
  UpdatesPage,
  type BusinessActions,
} from './pages-maintenance'
import type { V2Bridge, V2Page, V2SystemState } from './types'
import './business.css'

export type BusinessPageProps = Omit<BusinessActions, 'navigate'> & {
  /** 第二个参数是要落的分页（个人中心、设置），只有教程页会传；其他页照旧只传页面。 */
  navigate?: (page: V2Page, section?: string) => void
  api: V2Bridge
  page: V2Page
  state?: V2SystemState
  refresh?: () => void
  accountTab?: Parameters<typeof AccountPage>[0]['initialTab']
  accountTabRequest?: number
  /** 从活动卡片点某一档进来时要选好的充值金额；缺省 = 充值页照常从默认金额开始。 */
  accountRechargeAmount?: number
  /** 外壳手上的登录状态，个人中心自己读回来之前先拿它摆出左边分页；缺省 = 等个人中心自己读。 */
  accountSession?: Parameters<typeof AccountPage>[0]['accountSession']
  /** 教程页要停在哪一章；缺省 = 从第一章开始（旧行为）。 */
  tutorialTopic?: Parameters<typeof TutorialPage>[0]['topic']
  paymentReturn?: { sequence: number; order: string | null }
  /** 记录页「接着聊」成功、归档或恢复后回调，用来作废并重读首页那份「最近」缓存。 */
  onSessionsChanged?: () => void
  /** 记录页「接着聊」真打开之前，先过首页「打开」那几道关；缺省 = 不检查（旧行为）。 */
  beforeResume?: Parameters<typeof SessionsPage>[0]['beforeResume']
  /** 备份页恢复成功后回调，用来让首页重读这份配置。 */
  onBackupRestored?: Parameters<typeof BackupsPage>[0]['onRestored']
  /** 密钥页「配置到工具」写成功后回调，让首页重读工具配置（#479）。 */
  onToolConfigSaved?: () => void
  /** 工具设置窗口保存成功并读回之后的信号，用来收起密钥页「还在用刚撤销的密钥」（#546）。 */
  toolConfigConfirmed?: Parameters<typeof AccountPage>[0]['toolConfigConfirmed']
  /** 装好的命令行工具，扩展三页用它挑默认显示哪个；缺省 = 默认 Claude（旧行为）。 */
  installedProviders?: readonly string[]
  /** 订阅开通后把用得上它的工具换过去；缺省 = 不换（旧行为）。 */
  onSubscriptionActivated?: Parameters<typeof AccountPage>[0]['onSubscriptionActivated']
  onSubscriptionPurchased?: () => void
}

export function BusinessPage({
  api,
  page,
  accountTab,
  accountTabRequest,
  accountRechargeAmount,
  accountSession,
  tutorialTopic,
  paymentReturn,
  onSessionsChanged,
  beforeResume,
  onBackupRestored,
  onToolConfigSaved,
  toolConfigConfirmed,
  installedProviders,
  onSubscriptionActivated,
  onSubscriptionPurchased,
  ...actions
}: BusinessPageProps) {
  if (page === 'account')
    return (
      <AccountPage
        api={api}
        initialTab={accountTab}
        tabRequest={accountTabRequest}
        rechargeAmount={accountRechargeAmount}
        paymentReturn={paymentReturn}
        accountSession={accountSession}
        onLogin={actions.openLogin}
        onAccountChanged={actions.onAccountChanged ?? actions.refresh}
        onBack={actions.navigate ? () => actions.navigate?.('home') : undefined}
        onSwitchAccount={actions.switchAccount}
        onOpenHealth={actions.navigate ? () => actions.navigate?.('health') : undefined}
        onRewriteKey={actions.onRewriteKey}
        onConfigureTool={actions.openConfig}
        onToolConfigSaved={onToolConfigSaved}
        toolConfigConfirmed={toolConfigConfirmed}
        onSubscriptionActivated={onSubscriptionActivated}
        onSubscriptionPurchased={onSubscriptionPurchased}
        onOpenHelp={actions.openHelp}
      />
    )
  if (page === 'sessions')
    return <SessionsPage api={api} onSessionsChanged={onSessionsChanged} beforeResume={beforeResume} onOpenTools={actions.navigate ? () => actions.navigate?.('home') : undefined} />
  if (page === 'mcp')
    return <ExtensionsPage api={api} kind="mcp" onOpenHelp={actions.openHelp} installedProviders={installedProviders} />
  if (page === 'skills')
    return <ExtensionsPage api={api} kind="skill" onOpenHelp={actions.openHelp} onOpenTutorial={actions.navigate ? (section) => actions.navigate?.('tutorial', section) : undefined} installedProviders={installedProviders} />
  if (page === 'plugins')
    return <ExtensionsPage api={api} kind="plugin" onOpenHelp={actions.openHelp} installedProviders={installedProviders} />
  if (page === 'backups')
    return (
      <BackupsPage
        api={api}
        onRestored={onBackupRestored}
        navigate={actions.navigate}
      />
    )
  if (page === 'health') return <HealthPage api={api} {...actions} />
  if (page === 'feedback') return <FeedbackPage api={api} {...actions} />
  if (page === 'updates') return <UpdatesPage api={api} {...actions} />
  if (page === 'maintenance') return <MaintenancePage api={api} {...actions} />
  if (page === 'settings') return <SettingsPage api={api} {...actions} />
  if (page === 'tutorial') return <TutorialPage {...actions} topic={tutorialTopic} />
  return null
}

export {
  AccountPage,
  BackupsPage,
  ExtensionsPage,
  SessionsPage,
  FeedbackPage,
  HealthPage,
  MaintenancePage,
  SettingsPage,
  TutorialPage,
  UpdatesPage,
}
export { SavedAccounts } from './SavedAccounts'
