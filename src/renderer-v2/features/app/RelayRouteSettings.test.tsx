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
    // 历史账号也有直连了，这一行不再是灰的。
    expect(html).not.toMatch(/aria-label="历史账号线路"[^>]*disabled/)
  })

  it('shows auto as chosen when nothing is stored, with the approved option names', () => {
    const html = renderToStaticMarkup(<RelayRouteSettings settings={{ activeRelayEndpointIds: { solov: 'auto', 'solov-api': 'auto' } }} saving={false} restarting={false} onChange={() => undefined} onRestart={() => undefined} />)
    expect(html.match(/<option value="auto" selected="">自动（推荐）<\/option>/g)).toHaveLength(2)
    // 星芒账号叫洛杉矶、CF；历史账号照旧叫直连、默认线路。
    expect(html).toMatch(/aria-label="星芒账号线路".*只用洛杉矶.*只用 CF.*aria-label="历史账号线路".*只用直连.*只用默认线路/s)
    expect(html).toContain('自动会先走洛杉矶线路，连不上时改走 CF 线路。保存后重启星芒生效，不会切换账号。')
    expect(html).toContain('自动会先走直连，直连连不上时改走默认线路。保存后重启星芒生效，不会切换账号。')
    expect(html).not.toContain('settings-relay-relaunch')
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
