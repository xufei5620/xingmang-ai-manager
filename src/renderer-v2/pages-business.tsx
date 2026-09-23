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

export type BusinessPageProps = BusinessActions & {
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
