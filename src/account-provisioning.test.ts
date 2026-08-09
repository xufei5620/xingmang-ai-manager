import { describe, expect, it, vi } from 'vitest'
import { provisionCliKeyForInstalledClis, type CliKeyProvisioningApi } from './account-provisioning'

function fakeApi(overrides: Partial<CliKeyProvisioningApi> = {}): CliKeyProvisioningApi {
  return {
    provisionCliKey: vi.fn(async () => ({ key: 'sk-fresh-plaintext-key' })),
    listModels: vi.fn(async () => ['gpt-5.6-sol', 'claude-op-9']),
    saveConfig: vi.fn(async () => ({ backups: [], files: [] })),
    ...overrides,
  }
}

describe('provisionCliKeyForInstalledClis', () => {
  it('does nothing and never calls the account service when no CLI is installed', async () => {
    const api = fakeApi()

    const outcome = await provisionCliKeyForInstalledClis([], {}, api)

    expect(outcome).toEqual({ configured: [], failed: [] })
    expect(api.provisionCliKey).not.toHaveBeenCalled()
    expect(api.listModels).not.toHaveBeenCalled()
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('provisions exactly one key and reuses it across every installed CLI', async () => {
    const api = fakeApi()

    await provisionCliKeyForInstalledClis(['claude', 'codex', 'grok'], {}, api)

    expect(api.provisionCliKey).toHaveBeenCalledTimes(1)
    expect(api.listModels).toHaveBeenCalledTimes(1)
    expect(api.listModels).toHaveBeenCalledWith('sk-fresh-plaintext-key')
    expect(api.saveConfig).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(api.saveConfig).mock.calls) {
      expect(call[0].apiKey).toBe('sk-fresh-plaintext-key')
      expect(call[0].mode).toBe('merge')
    }
  })

  it('writes each installed provider with the resolved model, in order', async () => {
    const api = fakeApi()

    const outcome = await provisionCliKeyForInstalledClis(['claude', 'codex'], {}, api)

    expect(outcome).toEqual({ configured: ['claude', 'codex'], failed: [] })
    expect(vi.mocked(api.saveConfig).mock.calls[0][0]).toEqual({
      provider: 'claude',
      apiKey: 'sk-fresh-plaintext-key',
      model: 'gpt-5.6-sol',
      mode: 'merge',
    })
    expect(vi.mocked(api.saveConfig).mock.calls[1][0]).toEqual({
      provider: 'codex',
      apiKey: 'sk-fresh-plaintext-key',
      model: 'gpt-5.6-sol',
      mode: 'merge',
    })
  })

  it('prefers each provider\'s existing model when the fresh key still supports it', async () => {
    const api = fakeApi()

    await provisionCliKeyForInstalledClis(['claude', 'codex'], { claude: 'claude-op-9' }, api)

    expect(vi.mocked(api.saveConfig).mock.calls[0][0].model).toBe('claude-op-9')
    // codex has no preferred model recorded -> falls back to the first available.
    expect(vi.mocked(api.saveConfig).mock.calls[1][0].model).toBe('gpt-5.6-sol')
  })

  it('falls back to the first available model when the preferred one is no longer supported', async () => {
    const api = fakeApi()

    await provisionCliKeyForInstalledClis(['claude'], { claude: 'a-retired-model' }, api)

    expect(vi.mocked(api.saveConfig).mock.calls[0][0].model).toBe('gpt-5.6-sol')
  })

  it('never includes the plaintext key anywhere in the returned outcome (I3)', async () => {
    const api = fakeApi()

    const outcome = await provisionCliKeyForInstalledClis(['claude'], {}, api)

    expect(JSON.stringify(outcome)).not.toContain('sk-fresh-plaintext-key')
  })

  it('marks every installed provider failed, without calling saveConfig, when listing models fails', async () => {
    const api = fakeApi({ listModels: vi.fn(async () => { throw new Error('relay 暂不可用') }) })

    const outcome = await provisionCliKeyForInstalledClis(['claude', 'codex'], {}, api)

    expect(outcome.configured).toEqual([])
    expect(outcome.failed).toEqual([
      { provider: 'claude', message: 'relay 暂不可用' },
      { provider: 'codex', message: 'relay 暂不可用' },
    ])
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('marks every installed provider failed when the key has no usable models', async () => {
    const api = fakeApi({ listModels: vi.fn(async () => []) })

    const outcome = await provisionCliKeyForInstalledClis(['grok'], {}, api)

    expect(outcome.failed).toEqual([{ provider: 'grok', message: '当前 Key 未返回可用模型' }])
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('isolates a single provider\'s saveConfig failure so the others still succeed', async () => {
    const saveConfig = vi.fn(async (payload: { provider: string }) => {
      if (payload.provider === 'gemini') throw new Error('gemini 配置写入失败：磁盘只读')
      return { backups: [], files: [] }
    })
    const api = fakeApi({ saveConfig: saveConfig as CliKeyProvisioningApi['saveConfig'] })

    const outcome = await provisionCliKeyForInstalledClis(['claude', 'gemini', 'grok'], {}, api)

    expect(outcome.configured).toEqual(['claude', 'grok'])
    expect(outcome.failed).toEqual([{ provider: 'gemini', message: 'gemini 配置写入失败：磁盘只读' }])
    // Failure on one provider must not short-circuit the remaining ones.
    expect(api.saveConfig).toHaveBeenCalledTimes(3)
  })

  it('propagates a provisionCliKey rejection to the caller instead of a per-provider failure list', async () => {
    const api = fakeApi({ provisionCliKey: vi.fn(async () => { throw new Error('请先登录星芒账号') }) })

    await expect(provisionCliKeyForInstalledClis(['claude'], {}, api)).rejects.toThrow('请先登录星芒账号')
    expect(api.listModels).not.toHaveBeenCalled()
    expect(api.saveConfig).not.toHaveBeenCalled()
  })
})
