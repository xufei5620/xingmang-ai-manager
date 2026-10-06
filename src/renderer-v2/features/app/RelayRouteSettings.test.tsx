import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RelayRouteSettings } from './RelayRouteSettings'

describe('RelayRouteSettings', () => {
  it('shows a restart action for a saved pending choice without claiming it is active', () => {
    const html = renderToStaticMarkup(<RelayRouteSettings settings={{ relayEndpointIds: { solov: 'direct' } }} saving={false} restarting={false} onChange={() => undefined} onRestart={() => undefined} />)
    expect(html).toContain('线路已保存，等待重启')
    expect(html).toContain('settings-relay-relaunch-now')
    expect(html).toContain('不会切换账号')
    expect(html).not.toContain('线路已生效')
    expect(html).toMatch(/aria-label="历史账号线路"[^>]*disabled/)
  })

  it('disables the route and restart controls while a save is pending', () => {
    const html = renderToStaticMarkup(<RelayRouteSettings settings={{ relayEndpointIds: { solov: 'direct' } }} saving restarting={false} onChange={() => undefined} onRestart={() => undefined} />)
    expect(html).toMatch(/aria-label="星芒账号线路"[^>]*disabled/)
    expect(html).toMatch(/<button[^>]*data-testid="settings-relay-relaunch-now"[^>]*disabled/)
  })

  it('removes the restart notice once the startup snapshot confirms that route', () => {
    const html = renderToStaticMarkup(<RelayRouteSettings settings={{ relayEndpointIds: { solov: 'direct' }, activeRelayEndpointIds: { solov: 'direct' } }} saving={false} restarting={false} onChange={() => undefined} onRestart={() => undefined} />)
    expect(html).not.toContain('settings-relay-relaunch')
  })
})
