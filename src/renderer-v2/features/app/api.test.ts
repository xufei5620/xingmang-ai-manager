import { describe, expect, it, vi } from 'vitest'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { createAppApi } from './api'

function bootstrapFixture() {
  const settings = { version: 2, workspace: 'C:\\fixture' }
  const platform = { platform: 'win32' }
  const session = { authenticated: false, account: null }
  const update = { phase: 'disabled' }
  const capabilities = { lowEndDevice: false }
  const getConfig = vi.fn(async () => { throw new Error('配置文件暂时读不了') })
  const getSettings = vi.fn(async () => settings)
  const bridge = {
    getSettings, getPlatformCapabilities: vi.fn(async () => platform),
    getAccountSession: vi.fn(async () => session), getUpdateState: vi.fn(async () => update),
    getWindowCapabilities: vi.fn(async () => capabilities), getConfig,
  } as unknown as XingmangApi
  return { api: createAppApi(bridge), settings, platform, session, update, capabilities, getConfig, getSettings }
}

describe('app bootstrap', () => {
  it('opens the shell without reading tool configuration, which has its own recoverable partition', async () => {
    const fixture = bootstrapFixture()
    await expect(fixture.api.bootstrap()).resolves.toEqual({
      settings: fixture.settings, platform: fixture.platform, session: fixture.session,
      update: fixture.update, capabilities: fixture.capabilities,
    })
    expect(fixture.getConfig).not.toHaveBeenCalled()
  })

  it('still fails startup when a required settings read fails', async () => {
    const fixture = bootstrapFixture()
    fixture.getSettings.mockRejectedValueOnce(new Error('设置不可用'))
    await expect(fixture.api.bootstrap()).rejects.toThrow('设置不可用')
  })
})
