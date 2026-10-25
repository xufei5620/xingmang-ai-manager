import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CodexRemoteChannelSnapshot, CodexRemoteSnapshot } from '../../../../../electron/ipc-contract'
import type { V2Bridge } from '../../../types'
import { CodexRemoteCard, CodexRemotePanel } from './CodexRemoteCard'

function channel(patch: Partial<CodexRemoteChannelSnapshot> = {}): CodexRemoteChannelSnapshot {
  return { channel: 'feishu', hasCredential: false, accountLabel: null, enabled: false, status: { state: 'stopped' }, boundPeer: null, pairing: null, ...patch }
}

function snapshot(patch: Partial<CodexRemoteSnapshot> = {}, feishu: Partial<CodexRemoteChannelSnapshot> = {}): CodexRemoteSnapshot {
  return {
    revision: 1,
    available: true,
    credentialPersistence: 'durable',
    workspaceDirectory: null,
    task: 'idle',
    pendingApprovals: 0,
    channels: { feishu: channel(feishu) },
    ...patch,
  }
}

function render(state: CodexRemoteSnapshot, busy = '') {
  return renderToStaticMarkup(<CodexRemotePanel snapshot={state} api={{} as V2Bridge} busy={busy} run={async () => true} error={null} />)
}

function switchMarkup(markup: string) {
  return markup.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? ''
}

describe('codex remote card', () => {
  it('reads the state before drawing anything else', () => {
    const markup = renderToStaticMarkup(<CodexRemoteCard api={{} as V2Bridge} />)
    expect(markup).toContain('<h2>手机遥控 Codex</h2>')
    expect(markup).toContain('正在读取…')
  })

  it('starts with the folder and the Feishu app form, and keeps the switch off until both are there', () => {
    const markup = render(snapshot())
    expect(markup).toContain('选择文件夹')
    expect(markup).toContain('data-testid="settings-remote-feishu-form"')
    expect(markup).toContain('怎么建飞书机器人')
    expect(markup).toContain('先在上面填好飞书应用。')
    expect(switchMarkup(markup)).toContain('disabled=""')
    // 还没填应用时不摆配对那一行。
    expect(markup).not.toContain('data-testid="settings-remote-feishu-peer"')
  })

  it('shows the saved app by its App ID only and lets the switch on once the folder is chosen', () => {
    const markup = render(snapshot({ workspaceDirectory: '~/projects/demo' }, { hasCredential: true, accountLabel: 'cli_a1b2c3d4' }))
    expect(markup).toContain('App ID：cli_a1b2c3d4')
    expect(markup).not.toContain('data-testid="settings-remote-feishu-form"')
    expect(markup).toContain('换一个')
    expect(switchMarkup(markup)).not.toContain('disabled=""')
    expect(markup).toContain('还没配对。打开遥控后才能配对。')
  })

  it('shows the pairing code with where to send it', () => {
    const markup = render(snapshot(
      { workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' }, pairing: { code: '482915', expiresAt: 1 } },
    ))
    expect(markup).toMatch(/data-testid="settings-remote-feishu-code"[^>]*>482915</)
    expect(markup).toContain('在飞书里打开你建的机器人，私聊发这 6 位数字。10 分钟内有效。')
    expect(markup).toContain('已连上')
  })

  it('says why the channel stopped and does not repeat it once connected', () => {
    const stopped = render(snapshot({}, { hasCredential: true, status: { state: 'needs-login', message: 'App ID 或 App Secret 不对' } }))
    expect(stopped).toContain('要重新登录')
    expect(stopped).toContain('data-testid="settings-remote-feishu-status"')
    const connected = render(snapshot({}, { hasCredential: true, enabled: true, status: { state: 'connected', message: '旧原因' } }))
    expect(connected).not.toContain('旧原因')
  })

  it('locks every action when the manager runs elevated and says why', () => {
    const markup = render(snapshot(
      { available: false, unavailableReason: '星芒正以管理员身份运行。', workspaceDirectory: '~/projects/demo' },
      { hasCredential: true, accountLabel: 'cli_a1b2c3d4' },
    ))
    expect(markup).toContain('这台电脑现在不能打开手机遥控')
    expect(markup).toContain('星芒正以管理员身份运行。')
    expect(switchMarkup(markup)).toContain('disabled=""')
    expect(markup).toMatch(/data-testid="settings-remote-workspace" disabled=""/)
  })

  it('warns when the credentials only last until the manager closes', () => {
    expect(render(snapshot({ credentialPersistence: 'session-only' }))).toContain('凭据只记到这次关掉星芒')
    expect(render(snapshot({ credentialPersistence: 'unavailable' }))).toContain('凭据存不下')
    expect(render(snapshot())).not.toContain('data-testid="settings-remote-persistence"')
  })
})
