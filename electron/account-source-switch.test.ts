import { describe, expect, it, vi } from 'vitest'
import type { ProviderId } from './catalog'
import type { ConnectionCheckLayer, ConnectionCheckResult } from './connection-check'
import { AccountSourceServiceUnavailableError, shouldRollBackAfterCheck, switchAccountSource, type AccountSourceSwitchDependencies } from './account-source-switch'

function check(
  ok: boolean,
  layer: ConnectionCheckLayer,
  summary = '密钥被拒绝（HTTP 401），可能已被吊销或属于别的账号',
  extras: { status?: number, detail?: string } = {},
): ConnectionCheckResult {
  return {
    provider: 'claude', siteId: 'solov', ok, layer, summary, nextStep: '到「账号」页重新登录，然后在首页重新写入一次 Key',
    endpoint: null, model: null, detail: extras.detail ?? null, status: extras.status ?? (ok ? 200 : 401), durationMs: 1, checkedAt: '2026-09-22T00:00:00.000Z',
  }
}

function dependencies(overrides: Partial<AccountSourceSwitchDependencies> = {}) {
  const steps: string[] = []
  const deps: AccountSourceSwitchDependencies = {
    wasOfficial: () => true,
    createBackup: (provider: ProviderId) => { steps.push(`backup:${provider}`); return { id: 'backup-1' } },
    restoreBackup: (id: string) => { steps.push(`restore:${id}`) },
    writeAccountConfig: async () => { steps.push('write:account') },
    writeOfficialConfig: async () => { steps.push('write:official') },
    setOfficialPreference: async (_provider, official) => { steps.push(`preference:${official}`) },
    restoreOfficialCredentials: async () => { steps.push('credentials:restore') },
    checkConnection: async () => { steps.push('check'); return check(true, 'unknown', '连接正常') },
    officialLoginPresent: () => true,
    ...overrides,
  }
  return { deps, steps }
}

describe('switchAccountSource', () => {
  it('backs up before writing the account config and reports a verified switch', async () => {
    const { deps, steps } = dependencies()
    const result = await switchAccountSource(deps, 'claude', 'account')
    expect(steps).toEqual(['backup:claude', 'write:account', 'check'])
    expect(result).toMatchObject({ provider: 'claude', target: 'account', backupId: 'backup-1', verified: true, loginRequired: false })
    expect(result.message).toContain('已切到当前账号，连接自检通过')
    expect(result.message).toContain('关掉重开')
  })

  it('rolls everything back when the check says the written config cannot work', async () => {
    const { deps, steps } = dependencies({ checkConnection: async () => check(false, 'credential') })
    await expect(switchAccountSource(deps, 'claude', 'account')).rejects.toThrow(/没有连通：密钥被拒绝.*已恢复到切换前的配置/)
    expect(steps).toEqual(['backup:claude', 'write:account', 'restore:backup-1', 'credentials:restore', 'preference:true'])
  })

  it('restores the preference the tool had before, not a guessed one', async () => {
    const { deps, steps } = dependencies({ wasOfficial: () => false, writeAccountConfig: async () => { throw new Error('对应分组 Key 未就绪') } })
    await expect(switchAccountSource(deps, 'codex', 'account')).rejects.toThrow('切到当前账号没有完成：对应分组 Key 未就绪。已恢复到切换前的配置。')
    expect(steps).toContain('preference:false')
  })

  it.each(['network', 'unknown'] as const)('keeps the switch when the %s layer fails, but says it is unverified', async (layer) => {
    const { deps, steps } = dependencies({ checkConnection: async () => check(false, layer, '网络暂时连不上', { status: 500 }) })
    const result = await switchAccountSource(deps, 'codex', 'account')
    expect(steps).not.toContain('restore:backup-1')
    expect(result.verified).toBe(false)
    expect(result.message).toContain('这次没能确认能用：网络暂时连不上')
  })

  it('does not blame the key or roll back when the check says the service is unavailable', async () => {
    const { deps, steps } = dependencies({ checkConnection: async () => check(false, 'service', '服务暂时不可用（HTTP 522），多半在维护或线路繁忙', { status: 522 }) })
    const result = await switchAccountSource(deps, 'claude', 'account')
    expect(steps).toEqual(['backup:claude', 'write:account'])
    expect(result.verified).toBe(false)
    expect(result.message).toContain('服务暂时不可用（维护或线路繁忙），你这边不用做任何改动，稍后再试就行。')
    expect(result.message).not.toContain('密钥')
  })

  it('leaves the config alone when the service is unavailable while the key is being issued', async () => {
    const { deps, steps } = dependencies({ writeAccountConfig: async () => { throw new AccountSourceServiceUnavailableError() } })
    await expect(switchAccountSource(deps, 'codex', 'account')).rejects.toThrow(
      '切到当前账号没有完成：服务暂时不可用（维护或线路繁忙），你这边不用做任何改动，稍后再试就行。原来的配置没有改动。',
    )
    expect(steps).toEqual(['backup:codex'])
  })

  it('still rolls back a 503 that says the group has no channel', async () => {
    const { deps, steps } = dependencies({ checkConnection: async () => check(false, 'group', '当前账号分组下没有可用渠道', { status: 503, detail: '当前分组 default 下对于模型 x 无可用渠道' }) })
    await expect(switchAccountSource(deps, 'claude', 'account')).rejects.toThrow('已恢复到切换前的配置')
    expect(steps).toContain('restore:backup-1')
  })

  it('keeps the switch and passes on the quota advice when the quota ran out', async () => {
    const { deps, steps } = dependencies({ checkConnection: async () => ({
      ...check(false, 'quota', 'Codex 的额度用完了（HTTP 401），这是给这个工具设的上限', { status: 401, detail: '该令牌额度已用尽' }),
      nextStep: '到「账号」页「密钥」里调高这个工具的额度，调好后再自检一次',
    }) })
    const result = await switchAccountSource(deps, 'codex', 'account')
    expect(steps).not.toContain('restore:backup-1')
    expect(result.message).toContain('不过Codex 的额度用完了（HTTP 401），这是给这个工具设的上限。到「账号」页「密钥」里调高这个工具的额度')
    expect(result.message).not.toContain('密钥被拒绝')
  })

  it('does not call a rate limit an exhausted quota', async () => {
    const { deps } = dependencies({ checkConnection: async () => check(false, 'quota', '请求过于频繁或已达用量上限（HTTP 429）', { status: 429 }) })
    const result = await switchAccountSource(deps, 'codex', 'account')
    expect(result.message).toContain('这次没能确认能用：请求过于频繁')
  })

  it('keeps the switch when the check itself could not run', async () => {
    const { deps } = dependencies({ checkConnection: async () => { throw new Error('boom') } })
    const result = await switchAccountSource(deps, 'gemini', 'account')
    expect(result.verified).toBe(false)
    expect(result.message).toContain('连接自检没有完成')
  })

  it('does not touch any config when the backup fails', async () => {
    const write = vi.fn(async () => undefined)
    const { deps } = dependencies({ createBackup: () => { throw new Error('磁盘已满') }, writeAccountConfig: write, writeOfficialConfig: write })
    await expect(switchAccountSource(deps, 'claude', 'official')).rejects.toThrow('切换前的备份没有完成，已取消切换，配置没有改动：磁盘已满')
    expect(write).not.toHaveBeenCalled()
  })

  it('points the user at the backups page when the automatic rollback also fails', async () => {
    const { deps } = dependencies({
      checkConnection: async () => check(false, 'model'),
      restoreBackup: () => { throw new Error('文件被占用') },
    })
    await expect(switchAccountSource(deps, 'claude', 'account')).rejects.toThrow(/自动恢复也没有完成（文件被占用），请到「备份」里恢复切换前那一份/)
  })

  it('switches back to the official account without sending any request', async () => {
    const { deps, steps } = dependencies()
    const result = await switchAccountSource(deps, 'codex', 'official')
    expect(steps).toEqual(['backup:codex', 'write:official'])
    expect(result).toMatchObject({ target: 'official', verified: false, loginRequired: false })
    expect(result.message).toContain('Codex（包括桌面端）要关掉重开')
  })

  it('tells the user how to log in when no official login exists on this computer', async () => {
    const { deps } = dependencies({ officialLoginPresent: () => false })
    const result = await switchAccountSource(deps, 'claude', 'official')
    expect(result.loginRequired).toBe(true)
    expect(result.message).toContain('输入 /login')
  })

  it('does not claim a login is missing when it cannot tell', async () => {
    const { deps } = dependencies({ officialLoginPresent: () => null })
    expect((await switchAccountSource(deps, 'codex', 'official')).loginRequired).toBe(false)
  })

  it('restores the backup when switching back to official fails midway', async () => {
    const { deps, steps } = dependencies({ writeOfficialConfig: async () => { throw new Error('当前配置不是星芒中转') }, wasOfficial: () => false })
    await expect(switchAccountSource(deps, 'claude', 'official')).rejects.toThrow('切回官方账号没有完成')
    expect(steps).toEqual(['backup:claude', 'restore:backup-1', 'preference:false'])
  })
})

describe('shouldRollBackAfterCheck', () => {
  it('rolls back only on layers that mean the written config is wrong', () => {
    const base = { status: 400 }
    for (const layer of ['unconfigured', 'config', 'credential', 'group', 'model', 'protocol'] as const) expect(shouldRollBackAfterCheck({ ...base, ok: false, layer })).toBe(true)
    for (const layer of ['network', 'service', 'quota', 'unknown'] as const) expect(shouldRollBackAfterCheck({ ...base, ok: false, layer })).toBe(false)
    expect(shouldRollBackAfterCheck({ ...base, ok: true, layer: 'credential' })).toBe(false)
  })
})
