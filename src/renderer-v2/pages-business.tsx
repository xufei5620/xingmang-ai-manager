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
  /** 教程页要停在哪一章；缺省 = 从第一章开始（旧行为）。 */
  tutorialTopic?: Parameters<typeof TutorialPage>[0]['topic']
  paymentReturn?: { sequence: number; order: string | null }
  /** 记录页「接着聊」成功后回调，用来作废首页那份「最近」缓存。 */
  onSessionResumed?: () => void
  /** 备份页恢复成功后回调，用来让首页重读这份配置。 */
  onBackupRestored?: Parameters<typeof BackupsPage>[0]['onRestored']
  /** 密钥页「配置到工具」写成功后回调，让首页重读工具配置（#479）。 */
  onToolConfigSaved?: () => void
  /** 工具设置窗口保存成功并读回之后的信号，用来收起密钥页「还在用刚撤销的密钥」（#546）。 */
  toolConfigConfirmed?: Parameters<typeof AccountPage>[0]['toolConfigConfirmed']
}

export function BusinessPage({
  api,
  page,
  accountTab,
  accountTabRequest,
  tutorialTopic,
  paymentReturn,
  onSessionResumed,
  onBackupRestored,
  onToolConfigSaved,
  toolConfigConfirmed,
  ...actions
}: BusinessPageProps) {
  if (page === 'account')
    return (
      <AccountPage
        api={api}
        initialTab={accountTab}
        tabRequest={accountTabRequest}
        paymentReturn={paymentReturn}
        onLogin={actions.openLogin}
        onAccountChanged={actions.onAccountChanged ?? actions.refresh}
        onBack={actions.navigate ? () => actions.navigate?.('home') : undefined}
        onRewriteKey={actions.onRewriteKey}
        onConfigureTool={actions.openConfig}
        onToolConfigSaved={onToolConfigSaved}
        toolConfigConfirmed={toolConfigConfirmed}
      />
    )
  if (page === 'sessions')
    return <SessionsPage api={api} onResumed={onSessionResumed} />
  if (page === 'mcp') return <ExtensionsPage api={api} kind="mcp" />
  if (page === 'skills') return <ExtensionsPage api={api} kind="skill" />
  if (page === 'plugins') return <ExtensionsPage api={api} kind="plugin" />
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
