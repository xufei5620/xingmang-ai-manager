import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeLogStore } from './runtime-log'
import { buildExternalClientMacVerificationLogDetail, buildExternalClientRegistryLogDetail } from './system-service'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** 照 system-service 那样写进一份真的运行日志，再读回来：读回来的才是反馈报告里看得到的。 */
async function storedDetail(detail: Record<string, unknown>): Promise<unknown> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-external-client-log-'))
  temporaryDirectories.push(directory)
  const store = new RuntimeLogStore({ directory, appName: '星芒AI管理工具', appVersion: '1.0.0', packaged: false })
  store.log('warn', 'system', 'external-client.log-detail', 'detail', detail)
  await store.idle()
  return (await store.snapshot()).entries.find((entry) => entry.event === 'external-client.log-detail')?.detail
}

describe('external client log details', () => {
  const home = '/Users/peaker'

  it('keeps which uninstall entries could not be read once the runtime log has sanitized them', async () => {
    const detail = await storedDetail(buildExternalClientRegistryLogDetail([
      { entry: 'nbi-nb-all-8.0.2.0', reason: 'Specified cast is not valid.' },
      { entry: 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', reason: `Cannot read ${home}/registry.dat` },
    ], home))

    expect(detail).toMatchObject({
      failures: [
        { entry: 'nbi-nb-all-8.0.2.0', reason: 'Specified cast is not valid.' },
        { entry: 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
      ],
    })
    expect(JSON.stringify(detail)).not.toContain('[REDACTED]')
    expect(JSON.stringify(detail)).not.toContain(home)
    expect(JSON.stringify(detail)).toContain('/registry.dat')
  })

  it('keeps every field of a refused Mac client once the runtime log has sanitized it, without the home directory', async () => {
    const bundle = `${home}/Applications/Claude.app`
    const detail = await storedDetail(buildExternalClientMacVerificationLogDetail({
      tool: 'claudeDesktop', path: bundle, command: 'spctl', code: 'EXIT_NON_ZERO', exitCode: 3, output: `${bundle}: rejected`,
    }, home))

    expect(detail).toMatchObject({ tool: 'claudeDesktop', command: 'spctl', code: 'EXIT_NON_ZERO', exitCode: 3 })
    expect(JSON.stringify(detail)).not.toContain('[REDACTED]')
    expect(JSON.stringify(detail)).not.toContain(home)
    expect(detail).toMatchObject({ path: expect.stringMatching(/\/Applications\/Claude\.app$/), output: expect.stringMatching(/\/Applications\/Claude\.app: rejected$/) })
  })
})
