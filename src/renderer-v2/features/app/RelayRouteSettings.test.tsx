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
    // 两个账号都只叫线路1、线路2：默认那条（CF）是线路1，直连是线路2，线路1 排前面。
    expect(html).toMatch(/aria-label="星芒账号线路".*只用线路1.*只用线路2.*aria-label="历史账号线路".*只用线路1.*只用线路2/s)
    expect(html).not.toMatch(/洛杉矶|CF|直连|默认线路/)
    expect(html).toContain('自动会先走线路2，连不上时改走线路1。保存后重启星芒生效，不会切换账号。')
    expect(html).toContain('自动会先走线路1，线路1连不上时改走线路2。保存后重启星芒生效，不会切换账号。')
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
