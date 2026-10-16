import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RelayRouteRestartNotice, RelayRouteRow, RelayRouteSettings } from './RelayRouteSettings'
import { connectionRouteSettings } from '../../registry/connection-routes'

function routes(settings: Parameters<typeof RelayRouteSettings>[0]['settings'], disabled = false) {
  return renderToStaticMarkup(<RelayRouteSettings settings={settings} disabled={disabled} onChange={() => undefined} onRestart={() => undefined} />)
}

describe('RelayRouteSettings', () => {
  it('shows a restart action for a saved pending choice without claiming it is active', () => {
    const html = routes({ relayEndpointIds: { solov: 'direct' } })
    expect(html).toContain('线路已保存，等待重启')
    expect(html).toContain('settings-relay-relaunch-now')
    expect(html).toContain('不会切换账号')
    expect(html).not.toContain('线路已生效')
    // v4 只留标题和「现在重开」，「先保存工作」挪进点了以后的确认框。
    expect(html).not.toContain('重启星芒后使用新线路')
    // 确认框点了才出来。
    expect(html).not.toContain('现在重开星芒？')
    // 历史账号也有直连了，这一行不再是灰的。
    expect(html).not.toMatch(/aria-label="历史账号线路"[^>]*>[^]*?disabled=""/)
  })

  it('shows auto as chosen when nothing is stored, with the approved option names', () => {
    const html = routes({ activeRelayEndpointIds: { solov: 'auto', 'solov-api': 'auto' } })
    expect(html.match(/aria-pressed="true"[^>]*>自动（推荐）<\/button>/g)).toHaveLength(2)
    // 两个账号都只叫线路1、线路2：默认那条（CF）是线路1，直连是线路2，线路1 排前面。
    expect(html).toMatch(/aria-label="星芒账号线路".*只用线路1.*只用线路2.*aria-label="历史账号线路".*只用线路1.*只用线路2/s)
    expect(html).not.toMatch(/洛杉矶|CF|直连|默认线路/)
    expect(html).toContain('自动会先走线路2，连不上时改走线路1。保存后重启星芒生效，不会切换账号。')
    expect(html).toContain('自动会先走线路1，线路1连不上时改走线路2。保存后重启星芒生效，不会切换账号。')
    expect(html).not.toContain('settings-relay-relaunch')
  })

  it('disables the route and restart controls while a save is pending', () => {
    const html = routes({ relayEndpointIds: { solov: 'direct' } }, true)
    expect(html).toMatch(/aria-label="星芒账号线路"[^>]*><button[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*data-testid="settings-relay-relaunch-now"[^>]*disabled=""/)
  })

  it('removes the restart notice once the startup snapshot confirms that route', () => {
    const html = routes({ relayEndpointIds: { solov: 'direct' }, activeRelayEndpointIds: { solov: 'direct' } })
    expect(html).not.toContain('settings-relay-relaunch')
  })

  it('anchors each route row so the top search and the in-page search can find it', () => {
    const html = renderToStaticMarkup(<RelayRouteRow route={connectionRouteSettings[0]} settings={{}} disabled={false} onChange={() => undefined} />)
    expect(html).toContain('data-anchor="relay-route-solov"')
    expect(html).toContain('data-testid="settings-relay-route-solov"')
  })

  it('stays out of the way in settings until a saved route waits for a restart', () => {
    const idle = renderToStaticMarkup(<RelayRouteRestartNotice settings={{}} disabled={false} onRestart={() => undefined} />)
    expect(idle).toBe('')
  })
})
