import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPythonRuntimeInstallPlan,
  buildPythonRuntimeWingetPlan,
  installPythonRuntime,
  isPython312RuntimeVersion,
  normalizePythonRuntimeArchitecture,
  parsePythonReleaseFiles,
  parsePythonReleaseIndex,
  validatePythonAuthenticodeSignature,
  validatePythonResponseUrl,
  type InstalledPythonRuntimeInspection,
  type PythonRuntimeInstallerDependencies,
} from './python-runtime'

const temporaryDirectories: string[] = []
const release = { version: '3.12.9', releaseId: 1_234 }
const minimumInstallerBytes = 10 * 1024 * 1024

function commandResult(executable: string, argv: readonly string[], stdout = '') {
  return {
    executable,
    argv: [...argv],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    outputBytes: Buffer.byteLength(stdout),
    durationMs: 1,
  }
}

function response(body: BodyInit, url = ''): Response {
  const result = new Response(body, { status: 200 })
  if (url) Object.defineProperty(result, 'url', { value: url })
  return result
}

function installedInspection(): InstalledPythonRuntimeInspection {
  return {
    executable: 'C:\Users\tester\AppData\Local\Programs\Python\Python312\python.exe',
    version: 'Python 3.12',
    signature: { status: 'Valid', subject: 'CN=Python Software Foundation' },
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )))
})

describe('Python 3.12 release validation', () => {
  it('keeps published stable 3.12 releases sorted newest first', () => {
    const releases = parsePythonReleaseIndex(JSON.stringify([
      { name: 'Python 3.12.8', resource_uri: 'https://www.python.org/api/v2/downloads/release/100/', is_published: true, pre_release: false },
      { name: 'Python 3.13.2', resource_uri: 'https://www.python.org/api/v2/downloads/release/200/', is_published: true, pre_release: false },
      { name: 'Python 3.12.9', resource_uri: 'https://www.python.org/api/v2/downloads/release/300/', is_published: true, pre_release: false },
      { name: 'Python 3.12.10', resource_uri: 'https://www.python.org/api/v2/downloads/release/400/', is_published: true, pre_release: true },
    ]))
    expect(releases).toEqual([
      { version: '3.12.9', releaseId: 300 },
      { version: '3.12.8', releaseId: 100 },
    ])
  })

  it.each([
    ['x64', 'Windows installer (64-bit)', 'python-3.12.9-amd64.exe'],
    ['arm64', 'Windows installer (ARM64)', 'python-3.12.9-arm64.exe'],
  ] as const)('selects the exact %s installer asset', (architecture, name, fileName) => {
    const url = `https://www.python.org/ftp/python/3.12.9/${fileName}`
    expect(parsePythonReleaseFiles(JSON.stringify([{
      name,
      release: 'https://www.python.org/api/v2/downloads/release/1234/',
      url,
      filesize: minimumInstallerBytes,
    }]), release, architecture)).toMatchObject({ architecture, url, fileName })
  })

  it('recognizes only the supported 3.12 runtime family', () => {
    expect(isPython312RuntimeVersion('Python 3.12.9')).toBe(true)
    expect(isPython312RuntimeVersion('3.12')).toBe(true)
    expect(isPython312RuntimeVersion('Python 3.11.9')).toBe(false)
    expect(isPython312RuntimeVersion('Python 3.120.0')).toBe(false)
  })
})

describe('Python 3.12 trusted install plans', () => {
  it('builds current-user winget and official installer plans', () => {
    expect(normalizePythonRuntimeArchitecture('x64')).toBe('x64')
    expect(normalizePythonRuntimeArchitecture('arm64')).toBe('arm64')
    expect(() => normalizePythonRuntimeArchitecture('ia32')).toThrow('暂不支持')

    const winget = buildPythonRuntimeWingetPlan('C:/winget.exe')
    expect(winget.argv).toEqual(expect.arrayContaining([
      'Python.Python.3.12', '--scope', 'user', '--silent', '--disable-interactivity',
    ]))
    expect(winget.trustedOnly).toBeUndefined()
    const official = buildPythonRuntimeInstallPlan('C:\Temp\python-3.12.9-amd64.exe')
    expect(official.installer.argv).toEqual(expect.arrayContaining([
      '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1',
    ]))
    if (process.platform === 'win32') {
      expect(official.signature.env?.PSModulePath).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]Modules$/i)
      expect(official.signature.env?.PSModulePath).not.toContain('PowerShell\\7')
    }
    const encodedIndex = official.signature.argv.indexOf('-EncodedCommand') + 1
    const decodedScript = Buffer.from(official.signature.argv[encodedIndex], 'base64').toString('utf16le')
    expect(decodedScript).toContain("$ErrorActionPreference = 'Stop'")
    expect(decodedScript).toContain('Microsoft.PowerShell.Security.psd1')
  })

  it('rejects redirected downloads and non-PSF signatures', () => {
    const expected = 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe'
    expect(() => validatePythonResponseUrl(
      'https://downloads.example.invalid/python-3.12.9-amd64.exe',
      expected,
    )).toThrow('未经批准')
    expect(validatePythonAuthenticodeSignature({
      status: 'Valid',
      subject: 'CN=Example Software LLC',
    })).toContain('Python Software Foundation')
  })
})

describe.runIf(process.platform === 'win32')('Python 3.12 installation flow', () => {
  it('uses trusted winget without fetching an installer when verification succeeds', async () => {
    const runProcess = vi.fn<PythonRuntimeInstallerDependencies['runProcess']>(
      async (plan) => commandResult(plan.executable, plan.argv),
    )
    const fetchMock = vi.fn<typeof globalThis.fetch>()
    const inspect = vi.fn(async () => installedInspection())

    await expect(installPythonRuntime({ dependencies: {
      fetch: fetchMock,
      runProcess,
      resolveWingetExecutable: async () => ({ executable: 'C:/winget.exe', reason: null }),
      inspectInstalledPythonRuntime: inspect,
      createTemporaryDirectory: async () => 'C:/Temp/unused',
    } })).resolves.toMatchObject({ method: 'winget', source: 'winget', version: 'Python 3.12' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledOnce()
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({
      executable: 'C:/winget.exe',
      trustedOnly: false,
    }), undefined)
  })

  it('falls back to the signed python.org installer when winget fails', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-python-test-'))
    temporaryDirectories.push(directory)
    const installerName = 'python-3.12.9-amd64.exe'
    const installerUrl = `https://www.python.org/ftp/python/3.12.9/${installerName}`
    const releaseIndex = JSON.stringify([{
      name: 'Python 3.12.9',
      resource_uri: 'https://www.python.org/api/v2/downloads/release/1234/',
      is_published: true,
      pre_release: false,
    }])
    const releaseFiles = JSON.stringify([{
      name: 'Windows installer (64-bit)',
      release: 'https://www.python.org/api/v2/downloads/release/1234/',
      url: installerUrl,
      filesize: minimumInstallerBytes,
    }])
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/release/?')) return response(releaseIndex, url)
      if (url.includes('/release_file/?')) return response(releaseFiles, url)
      return response(new Uint8Array(minimumInstallerBytes), installerUrl)
    })
    let processCall = 0
    const runProcess = vi.fn<PythonRuntimeInstallerDependencies['runProcess']>(async (plan) => {
      processCall += 1
      if (processCall === 1) throw new Error('winget unavailable')
      const stdout = plan.executable.toLowerCase().includes('powershell')
        ? JSON.stringify({ status: 'Valid', subject: 'CN=Python Software Foundation' })
        : ''
      return commandResult(plan.executable, plan.argv, stdout)
    })

    await expect(installPythonRuntime({ dependencies: {
      fetch: fetchMock,
      runProcess,
      resolveWingetExecutable: async () => ({ executable: 'C:/winget.exe', reason: null }),
      inspectInstalledPythonRuntime: async () => installedInspection(),
      createTemporaryDirectory: async () => directory,
      removeTemporaryDirectory: async () => undefined,
    } })).resolves.toMatchObject({ method: 'exe', source: 'python-org', version: 'Python 3.12' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(runProcess).toHaveBeenCalledTimes(3)
  })
})
