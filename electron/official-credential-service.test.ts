import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createOfficialCredentialService } from './official-credential-service'
import type { SystemServiceOptions } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 3 步把官方账号来回切那一段搬成了 createOfficialCredentialService。切回官方、恢复备份对齐来源的全过程
// 仍由 system-service.test.ts、tool-config-ownership.test.ts 经 createSystemService 覆盖；这里钉住搬家新接上的那几处：
// 挪开和放回用的是上下文给的那份主目录，改官方记号排在上下文那条写配置的队里（保存配置也排这条），撤回失败时
// 把现在的状态补进报错。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createService(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-official-credential-service-'))
  temporaryDirectories.push(root)
  const userHome = path.join(root, 'home')
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true })
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome, codexHome: path.join(root, 'codex') },
    ...options,
  })
  return { context, store, userHome, service: createOfficialCredentialService(context) }
}

function readRootConfig(userHome: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(userHome, '.claude.json'), 'utf8')) as Record<string, unknown>
}

describe('official credential service', () => {
  it('moves the Claude Console key aside and puts it back under the context home', () => {
    const logged: string[] = []
    const { service, userHome } = createService({ runtimeLog: { log: (_level, _source, event) => { logged.push(event) } } })
    fs.writeFileSync(path.join(userHome, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk-ant-fixture', theme: 'dark' }))

    expect(service.moveOfficialCredentialsAside()).toBe(true)
    expect(readRootConfig(userHome)).toEqual({ theme: 'dark' })
    expect(logged).toEqual(['official-credentials.moved'])

    expect(service.restoreOfficialCredentialsNow()).toBe(true)
    expect(readRootConfig(userHome)).toEqual({ theme: 'dark', primaryApiKey: 'sk-ant-fixture' })
  })

  it('waits for a config write already in the shared queue before changing the official flag', async () => {
    const { context, store, service } = createService()
    let releaseWrite!: () => void
    const pendingWrite = context.serializeConfigWrite(() => new Promise<void>((resolve) => { releaseWrite = resolve }))

    const flagged = service.setOfficialSourcePreference('claude', true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.read().officialProviders ?? []).not.toContain('claude')

    releaseWrite()
    await Promise.all([pendingWrite, flagged])
    expect(store.read().officialProviders).toContain('claude')
  })

  it('keeps the original error when the undo works and says what is left when it does not', () => {
    const { service } = createService()
    const failure = new Error('配置没写进去')

    expect(service.withCredentialUndo(failure, () => undefined, '官方 Key 还在一边')).toBe(failure)
    const reported = service.withCredentialUndo(failure, () => { throw new Error('放不回去') }, '官方 Key 还在一边')
    expect(reported).toBeInstanceOf(Error)
    expect((reported as Error).message).toBe('配置没写进去（官方 Key 还在一边）')
  })
})
