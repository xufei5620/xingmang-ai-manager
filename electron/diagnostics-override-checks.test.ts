import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId } from './catalog'
import type { NativeConfigInspection } from './config-files'
import type { CheckOutcome, DiagnosticsDependencies } from './diagnostics'
import { createDiagnosticsContext } from './diagnostics-context'
import { buildOverrideChecks } from './diagnostics-override-checks'

// readSafeUtf8File 每读一个文件都先在主线程上把整条路径逐级同步核一遍（I8）。记下终端设置文件里哪些走到了它。
const reads = vi.hoisted(() => ({ shellSettings: [] as string[] }))
vi.mock('./safe-local-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('./safe-local-data')>()
  return {
    ...original,
    async readSafeUtf8File(filePath: string, label: string, maximumBytes?: number) {
      if (label === '终端设置文件') reads.shellSettings.push(filePath)
      return original.readSafeUtf8File(filePath, label, maximumBytes)
    },
  }
})

const temporaryDirectories: string[] = []

afterEach(() => {
  reads.shellSettings.length = 0
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-override-checks-'))
  temporaryDirectories.push(directory)
  return directory
}

// 各家都用星芒账号：只有这样终端设置文件才会去看（collectShellOverrides 只看用星芒账号的工具）。
function relayInspection(provider: ProviderId, home: string): NativeConfigInspection {
  return {
    baseUrl: provider === 'claude' ? 'https://xm.solov.cc' : 'https://xm.solov.cc/v1',
    actualBaseUrl: provider === 'claude' ? 'https://xm.solov.cc' : 'https://xm.solov.cc/v1',
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    apiKey: 'sk-super-secret-value',
    model: 'gpt-5.6-sol',
    dataDirectory: path.join(home, `.${provider}`),
    dataDirectoryExists: true,
    files: [],
    updatedAt: '2026-07-24T00:00:00.000Z',
  }
}

async function runEnvironmentOverrideCheck(input: DiagnosticsDependencies): Promise<CheckOutcome> {
  const check = buildOverrideChecks(createDiagnosticsContext(input))
    .find((entry) => entry.code === 'PROVIDER_ENVIRONMENT_OVERRIDE')
  if (!check) throw new Error('PROVIDER_ENVIRONMENT_OVERRIDE is missing')
  return check.run(new AbortController().signal)
}

describe('diagnostics override checks', () => {
  describe('PROVIDER_ENVIRONMENT_OVERRIDE', () => {
    // CI 上偶发「检查超时」的根因（windows-test vitest-2、macos-test）：以前十来个候选文件一个接一个地交给
    // readSafeUtf8File，不在的也要把主目录整条核一遍，Windows 上这一项就压着检查的时限跑完。
    it.each(['win32', 'darwin', 'linux'] as const)('sends only the shell settings files that exist through the safe reader on %s', async (platform) => {
      const home = temporaryHome()
      fs.writeFileSync(path.join(home, '.bashrc'), 'export ANTHROPIC_API_KEY=sk-shell\n')

      await runEnvironmentOverrideCheck({
        app: { name: '星芒AI管理工具', version: '1.0.0', packaged: false },
        homeDirectory: home,
        platform,
        env: {},
        inspectProvider: (provider) => relayInspection(provider, home),
      })

      expect(reads.shellSettings).toEqual([path.join(home, '.bashrc')])
    })
  })
})
