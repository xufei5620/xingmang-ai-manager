import type { ReactNode } from 'react'

export function ToolRow({
  providerId,
  installState,
  identity,
  version,
  source,
  status,
  primaryAction,
  moreActions,
  children,
}: {
  providerId: string
  installState: 'installing' | 'failed' | 'installed' | 'missing'
  identity: ReactNode
  version: ReactNode
  source: ReactNode
  status: ReactNode
  primaryAction: ReactNode
  moreActions?: ReactNode
  children?: ReactNode
}) {
  return (
    <article className="dashboard-tool-entry" role="rowgroup" data-provider-id={providerId} data-install-state={installState}>
      <div className="dashboard-tool-row" role="row">
        <div className="dashboard-tool-identity" role="cell">{identity}</div>
        <div className="dashboard-tool-version" role="cell">{version}</div>
        <div className="dashboard-tool-source" role="cell">{source}</div>
        <div className="dashboard-tool-state" role="cell">{status}</div>
        <div className="dashboard-tool-primary" role="cell">{primaryAction}</div>
        <div className="dashboard-tool-more" role="cell">{moreActions}</div>
      </div>
      {children && <div role="row" className="dashboard-tool-detail-row">
        <div role="cell" aria-colspan={6} className="dashboard-tool-details">{children}</div>
      </div>}
    </article>
  )
}
