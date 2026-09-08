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
  paymentReturn?: { sequence: number; order: string | null }
}

export function BusinessPage({
  api,
  page,
  accountTab,
  paymentReturn,
  ...actions
}: BusinessPageProps) {
  if (page === 'account')
    return (
      <AccountPage
        api={api}
        initialTab={accountTab}
        paymentReturn={paymentReturn}
        onLogin={actions.openLogin}
        onAccountChanged={actions.onAccountChanged ?? actions.refresh}
        onBack={actions.navigate ? () => actions.navigate?.('home') : undefined}
      />
    )
  if (page === 'sessions') return <SessionsPage api={api} />
  if (page === 'mcp') return <ExtensionsPage api={api} kind="mcp" />
  if (page === 'skills') return <ExtensionsPage api={api} kind="skill" />
  if (page === 'plugins') return <ExtensionsPage api={api} kind="plugin" />
  if (page === 'backups') return <BackupsPage api={api} />
  if (page === 'health') return <HealthPage api={api} {...actions} />
  if (page === 'feedback') return <FeedbackPage api={api} {...actions} />
  if (page === 'updates') return <UpdatesPage api={api} {...actions} />
  if (page === 'maintenance') return <MaintenancePage api={api} {...actions} />
  if (page === 'settings') return <SettingsPage api={api} {...actions} />
  if (page === 'tutorial') return <TutorialPage {...actions} />
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
