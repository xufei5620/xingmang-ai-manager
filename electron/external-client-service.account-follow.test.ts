import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { externalClientNames } from './external-client-contract'
import { ExternalClientOwnershipStore, type ExternalClientKeySource } from './external-client-ownership'
import type { ExternalToolId } from './external-tool-config'
import { configureManagedClis } from './account-cli-provisioner'
import { resolveManagedCliKeyProfiles } from './catalog'
import { fixture, removeTemporaryDirectories, selectedModel } from './external-client-service.test-support'

afterEach(removeTemporaryDirectories)

describe('external clients follow the tool into the account the customer switched to (known 37)', () => {
  const firstKey = 'sk-claude-code-first-account-123456'
  const secondKey = 'sk-claude-code-second-account-123456'
  const firstCodexKey = 'sk-codex-first-account-123456'
  const secondCodexKey = 'sk-codex-second-account-123456'
  const codexModel = 'gpt-5.4'
  const first = JSON.stringify(['solov', 17])
  const second = JSON.stringify(['solov', 18])
  type Fixture = ReturnType<typeof fixture>
  type AccountService = Parameters<typeof configureManagedClis>[0]

  // 账号后端：每个账号的 Claude Code、Codex 那一组各签出这个账号的那一把，别的工具给一把不相干的。
  function accountService(userId: number): AccountService {
    const profiles = resolveManagedCliKeyProfiles('solov')
    const keys = userId === 17 ? { claude: firstKey, codex: firstCodexKey } : { claude: secondKey, codex: secondCodexKey }
    return {
      getSessionState: () => ({ authenticated: true, account: { userId } }),
      getActiveSiteId: () => 'solov',
      provisionCliKey: vi.fn(async (input: { name?: string; group?: string } = {}) => input.group === profiles.claude.group
        ? { id: userId * 10 + 1, name: input.name ?? '', key: keys.claude }
        : input.group === profiles.codex.group ? { id: userId * 10 + 2, name: input.name ?? '', key: keys.codex }
          : { id: userId * 10 + 3, name: input.name ?? '', key: `sk-other-tool-${userId}-123456` }),
    } as unknown as AccountService
  }

  function install(f: Fixture, tool: 'workbuddy' | 'opencode') {
    const status = f.runtimeStatuses.find((entry) => entry.tool === tool)!
    Object.assign(status, { installed: true, version: '1.0.0', path: path.join(f.directory, tool, `${tool}.exe`), installDirectory: path.join(f.directory, tool) })
  }

  // 第一个账号下：工具连上星芒签的那把，客户端选「使用某工具当前的星芒密钥」保存。
  async function connectFirstAccount(f: Fixture, tool: ExternalToolId = 'claudeDesktop', options: { source?: ExternalClientKeySource; key?: string } = {}) {
    if (tool !== 'claudeDesktop') install(f, tool)
    const outcome = await configureManagedClis(accountService(17), f.service, ['claude', 'codex'], {}, false, f.keyStore!, 'merge', 'explicit')
    expect(outcome.failed).toEqual([])
    const borrowed = options.key ?? (tool === 'claudeDesktop' ? firstKey : firstCodexKey)
    const saved = await f.service.configureExternalTool(tool, { apiKey: borrowed, model: tool === 'claudeDesktop' ? selectedModel : codexModel }, undefined, options.source ?? 'configured')
    return { file: saved.path, before: fs.readFileSync(saved.path, 'utf8') }
  }

  // 换到第二个账号，在「同步到工具」里勾上这些工具（account-switch-sync.ts 点名写 Key）。
  async function switchToSecond(f: Fixture, providers: ('claude' | 'codex')[] = ['claude', 'codex']) {
    f.setUser(18)
    return configureManagedClis(accountService(18), f.service, providers, {}, false, f.keyStore!, 'merge', 'explicit')
  }

  function keyLogs(f: Fixture) {
    return f.runtimeLog.log.mock.calls.filter(([, , event]) => event.startsWith('external-client.key.'))
  }

  async function followed(f: Fixture, times = 1) {
    await vi.waitFor(() => expect(keyLogs(f).filter(([, , event]) => event === 'external-client.key.followed')).toHaveLength(times), { timeout: 10_000 })
  }

  function ownership(f: Fixture) {
    return new ExternalClientOwnershipStore(path.join(f.managerDataDirectory, 'external-client-ownership'))
  }

  it('moves Claude Desktop onto the new account with Claude Code, changing nothing but the key', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectFirstAccount(f)
    expect(before).toContain(firstKey)

    expect((await switchToSecond(f)).failed).toEqual([])
    await followed(f)
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replace(`"${firstKey}"`, `"${secondKey}"`))
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.followed', '已把 Claude Desktop 换成 Claude Code 现在用的密钥',
      { tool: 'claudeDesktop', route: 'primary', accountSwitch: true }]])
    // 这一轮是保存配置后台换的，界面要重读。
    await vi.waitFor(() => expect(f.routeFollowed).toHaveBeenCalledTimes(1))
    expect(ownership(f).inspect('claudeDesktop', second, 'https://xm.solov.cc', secondKey)).toEqual({ source: 'configured' })
    expect((await f.service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop'))
      .toMatchObject({ configured: true, configurationSource: 'xingmang', model: selectedModel })
    expect(JSON.stringify(f.runtimeLog.log.mock.calls)).not.toMatch(/sk-claude-code|solov\.cc/)
  })

  it('asks the window to reload once when both synced tools follow at the same time', async () => {
    const f = fixture({ managedKeys: true })
    await connectFirstAccount(f)
    // 保存 Claude Code 后台那一眼停在盘点客户端，Codex 也保存完、也叫过那一眼才放行：两轮一定撞上
    // （上面那条在 Mac CI 上是碰巧撞上，#1413）。
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(f.runtime.scan).mockImplementation(async () => {
      await held
      return structuredClone(f.runtimeStatuses)
    })

    expect((await switchToSecond(f)).failed).toEqual([])
    release()
    await followed(f)
    await vi.waitFor(() => expect(f.routeFollowed).toHaveBeenCalled(), { timeout: 10_000 })
    // 再检测一次：排在后台那几轮后面，它们都跑完了才回来。
    await f.service.scanExternalClients()
    expect(f.routeFollowed).toHaveBeenCalledTimes(1)
    expect(keyLogs(f).filter(([, , event]) => event === 'external-client.key.followed')).toHaveLength(1)
  })

  it('moves Claude Desktop back when the customer switches back and syncs Claude Code again', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectFirstAccount(f)
    await switchToSecond(f)
    await followed(f)

    f.setUser(17)
    expect((await configureManagedClis(accountService(17), f.service, ['claude'], {}, false, f.keyStore!, 'merge', 'explicit')).failed).toEqual([])
    await followed(f, 2)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect((await f.service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop'))
      .toMatchObject({ configured: true, configurationSource: 'xingmang' })
    expect(ownership(f).inspect('claudeDesktop', first, 'https://xm.solov.cc', firstKey)).toEqual({ source: 'configured' })
  })

  it.each(['workbuddy', 'opencode'] as const)('moves %s onto the new account with Codex', async (tool) => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectFirstAccount(f, tool)
    expect(before).toContain(firstCodexKey)

    await switchToSecond(f, ['codex'])
    await followed(f)
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replaceAll(`"${firstCodexKey}"`, `"${secondCodexKey}"`))
    expect(keyLogs(f)).toEqual([['info', 'config', 'external-client.key.followed', `已把 ${externalClientNames[tool]} 换成 Codex CLI 现在用的密钥`,
      { tool, route: 'primary', accountSwitch: true }]])
    expect((await f.service.scanExternalClients()).find((client) => client.tool === tool)).toMatchObject({ configured: true, configurationSource: 'xingmang', model: codexModel })
  })

  it('leaves Claude Desktop on the old account when the customer did not sync Claude Code', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectFirstAccount(f)

    await switchToSecond(f, ['codex'])
    await f.service.scanExternalClients(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([])
    expect((await f.service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop')).toMatchObject({ configured: false, configurationSource: 'other' })
  })

  it('leaves a key the customer typed into Claude Desktop alone, even when it is the old account\'s Claude Code key', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectFirstAccount(f, 'claudeDesktop', { source: 'manual' })

    await switchToSecond(f)
    await f.service.scanExternalClients(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([])
  })

  it('leaves Claude Desktop alone when it uses another key of the old account than its tools had', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectFirstAccount(f, 'claudeDesktop', { source: 'account', key: 'sk-another-first-account-key-123456' })

    await switchToSecond(f)
    await f.service.scanExternalClients(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(keyLogs(f)).toEqual([])
  })

  it('waits for a running Claude Desktop to quit, follows by itself, and catches up after a restart too', async () => {
    const f = fixture({ managedKeys: true })
    const { file, before } = await connectFirstAccount(f)
    const claude = f.runtimeStatuses.find((status) => status.tool === 'claudeDesktop')!
    claude.running = true

    await switchToSecond(f)
    await vi.waitFor(() => expect(f.routeTimers.map((timer) => timer.delayMs)).toEqual([5 * 60 * 1000]), { timeout: 10_000 })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect((await f.service.scanExternalClients()).find((client) => client.tool === 'claudeDesktop')).toMatchObject({ running: true, keyPending: true })

    // 星芒先关了，客户端后退出：下次打开那一轮检测补上。
    claude.running = false
    await f.restart().scanExternalClients()
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replace(`"${firstKey}"`, `"${secondKey}"`))
  })
})
