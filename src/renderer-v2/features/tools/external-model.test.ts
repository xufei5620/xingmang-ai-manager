import { describe, expect, it } from 'vitest'
import type { ExternalClientStatus } from '../../../../electron/ipc-contract'
import { presentExternalClients } from './external-model'
import { isToolId } from './model'

const status: ExternalClientStatus = { tool: 'workbuddy', installed: false, version: null, path: null, installDirectory: null, running: false, installSupported: true, launchSupported: true, detectionError: null, installHint: null, configured: false, model: null, configurationSource: 'missing', configurationError: null }
const present = (patch: Partial<ExternalClientStatus>) => presentExternalClients([{ ...status, ...patch }])[0]

describe('external client lifecycle presentation', () => {
  it('keeps external clients outside the provider configuration tool IDs', () => {
    for (const tool of ['workbuddy', 'claudeDesktop', 'opencode']) expect(isToolId(tool)).toBe(false)
    expect(isToolId('codexDesktop')).toBe(true)
  })
  it('moves from install to configure to launch using detected state', () => {
    expect(present({}).action).toBe('install')
    expect(present({ installed: true }).action).toBe('configure')
    expect(present({ installed: true, configured: true, configurationSource: 'xingmang' }).action).toBe('launch')
  })
  it('opens an existing third-party configuration without assuming account ownership', () => {
    const value = present({ installed: true, configurationSource: 'other' })
    expect(value.action).toBe('launch')
    expect(value.ready).toBe(true)
    expect(value.configurationStatus).toBe('unknownSource')
    expect(value.detail).toContain('已有第三方配置')
  })
  it('shows a complete manual Claude configuration as ready without associating an account', () => {
    const value = present({ tool: 'claudeDesktop', installed: true, configurationSource: 'other', configurationReady: true })
    expect(value).toMatchObject({ ready: true, action: 'launch', configurationStatus: 'ready', status: { configured: false, configurationSource: 'other' } })
    expect(value.detail).toContain('自动获取模型')
    expect(value.detail).not.toContain('其他账号')
  })
  it('does not mark an incomplete or unreadable Claude configuration as ready', () => {
    const value = present({ tool: 'claudeDesktop', installed: true, configurationSource: 'other', configurationReady: false })
    expect(value).toMatchObject({ ready: false, action: 'configure', configurationStatus: 'unconfigured' })
    expect(value.detail).toContain('配置待完善')
    expect(present({ tool: 'claudeDesktop', installed: true, configured: true, configurationReady: true, configurationError: 'config denied' }))
      .toMatchObject({ ready: false, action: 'configure', configurationStatus: 'unconfigured', detail: 'config denied' })
  })
  it('separates runtime detection failure from configuration read failure', () => {
    expect(present({ installed: true, detectionError: 'path denied' }).action).toBe('scan')
    const value = present({ installed: true, configurationSource: 'unknown', configurationError: 'config denied' })
    expect(value.action).toBe('configure')
    expect(value.detail).toBe('config denied')
  })

  it('redacts the local path either snapshot error carries onto the client row (R-S7b)', () => {
    // Both fields reach the screen as the row subtitle without passing through
    // errorMessage, so I13's redaction has to happen here.
    expect(present({ installed: true, detectionError: "EACCES: permission denied, open 'C:\\Users\\yoyo\\AppData\\Local\\WorkBuddy\\config.json'" }).detail)
      .toBe("EACCES: permission denied, open '本地配置文件")
    // 现有脱敏以空白收尾，带空格的目录名只剥到空格为止；要紧的用户名这一段已经去掉。
    const configuration = present({ installed: true, configurationSource: 'unknown', configurationError: '读取 /Users/yoyo/Library/Application Support/config.json 失败' }).detail
    expect(configuration).toBe('读取 本地配置文件 Support/config.json 失败')
    expect(configuration).not.toContain('yoyo')
    // 脱敏后为空的错误字段不能把后面的版本、安装文案挡掉。
    expect(present({ installed: true, version: 'v2.0', detectionError: '  ' }).detail).toBe('v2.0')
  })

  it('respects platform support and keeps version/model/running details visible', () => {
    expect(present({ installSupported: false, installHint: 'manual only' })).toMatchObject({ disabled: true, detail: 'manual only' })
    expect(present({ installed: true, configured: true, launchSupported: false }).disabled).toBe(true)
    expect(present({ installed: true, running: true, version: 'v2.0', model: 'deepseek-test' }).detail).toBe('v2.0 · 运行中 · deepseek-test')
  })
})
