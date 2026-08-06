import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGrokArtifactUrls,
  cleanupDownloadedGrokBinary,
  downloadLatestGrokBinary,
  grokWindowsArchitecture,
  GrokRollbackError,
  installDownloadedGrokBinary,
  recoverInterruptedGrokInstallation,
  validateGrokArtifactResponseUrl,
  type DownloadedGrokBinary,
} from './grok-installer'
import type { GrokVersionFetch } from './grok-update'
import type { VerifiedNativeCliFile } from './trusted-native-cli'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url })
  return response
}

async function fakeVerification(_provider: string, filePath: string): Promise<VerifiedNativeCliFile> {
  const content = fs.readFileSync(filePath)
  return {
    path: filePath,
    sha256Hex: createHash('sha256').update(content).digest('hex'),
    size: content.length,
  }
}

describe('Grok signed binary installer', () => {
  it('builds only the fixed official artifacts for the selected architecture', () => {
    expect(grokWindowsArchitecture('x64')).toBe('x86_64')
    expect(grokWindowsArchitecture('arm64')).toBe('aarch64')
    expect(() => grokWindowsArchitecture('ia32')).toThrow('不支持')
    expect(buildGrokArtifactUrls(
      '0.2.112',
      'x64',
      'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
    )).toEqual([
      'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-0.2.112-windows-x86_64.exe',
      'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-0.2.112-windows-x86_64',
      'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      'https://x.ai/cli/grok-0.2.112-windows-x86_64',
    ])
  })

  it('rejects cross-host redirects and altered artifact paths', () => {
    const expected = 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe'
    expect(() => validateGrokArtifactResponseUrl(expected, expected)).not.toThrow()
    expect(() => validateGrokArtifactResponseUrl(
      'https://evil.example/grok.exe',
      expected,
    )).toThrow('不受信任的重定向')
    expect(() => validateGrokArtifactResponseUrl(
      'https://x.ai/cli/other.exe',
      expected,
    )).toThrow('不受信任的重定向')
  })

  it('downloads a bounded official binary and verifies it before returning', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
    temporaryDirectories.push(directory)
    const binary = Buffer.alloc(1024 * 1024, 0x5a)
    const artifactUrl = 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe'
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(responseWithUrl('0.2.112\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }, 'https://x.ai/cli/stable'))
      .mockResolvedValueOnce(responseWithUrl(binary, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(binary.length),
        },
      }, artifactUrl))
    const progress = vi.fn()

    const result = await downloadLatestGrokBinary({
      fetchImpl,
      architecture: 'x64',
      createTemporaryDirectory: async () => directory,
      verifyBinary: fakeVerification,
      onProgress: progress,
    })

    expect(result).toMatchObject({ version: '0.2.112', sourceUrl: artifactUrl, size: binary.length })
    expect(fs.statSync(result.binaryPath).size).toBe(binary.length)
    expect(progress).toHaveBeenLastCalledWith({
      transferred: binary.length,
      total: binary.length,
      percent: 100,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('installs verified grok/agent binaries and local version metadata in a protected root', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-install-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const managedRoot = path.join(directory, 'managed')
    fs.mkdirSync(downloadDirectory)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const content = Buffer.from('signed-test-binary')
    fs.writeFileSync(binaryPath, content)
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: content.length,
      sha256Hex: createHash('sha256').update(content).digest('hex'),
    }
    const applyWindowsAcl = vi.fn(async () => undefined)

    const installed = await installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot,
      applyWindowsAcl,
      verifyBinary: fakeVerification,
    })

    expect(fs.readFileSync(installed.executablePath)).toEqual(content)
    expect(fs.readFileSync(installed.agentPath)).toEqual(content)
    expect(JSON.parse(fs.readFileSync(path.join(managedRoot, 'version.json'), 'utf8'))).toMatchObject({
      version: '0.2.112',
      stable_version: '0.2.112',
    })
    expect(applyWindowsAcl).toHaveBeenCalledWith(managedRoot, process.env)
    await cleanupDownloadedGrokBinary(download)
    expect(fs.existsSync(downloadDirectory)).toBe(false)
  })

  it('installs into a current-user directory without applying administrator ACLs', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-user-install-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const userRoot = path.join(directory, '.grok', 'bin')
    fs.mkdirSync(downloadDirectory)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const content = Buffer.from('signed-user-test-binary')
    fs.writeFileSync(binaryPath, content)
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: content.length,
      sha256Hex: createHash('sha256').update(content).digest('hex'),
    }
    const applyWindowsAcl = vi.fn(async () => undefined)

    const installed = await installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot: userRoot,
      protectInstallDirectory: false,
      applyWindowsAcl,
      verifyBinary: fakeVerification,
    })

    expect(installed.installDirectory).toBe(userRoot)
    expect(fs.readFileSync(installed.executablePath)).toEqual(content)
    expect(fs.readFileSync(installed.agentPath)).toEqual(content)
    expect(fs.existsSync(path.join(userRoot, 'version.json'))).toBe(true)
    expect(applyWindowsAcl).not.toHaveBeenCalled()
  })

  it('restores both executables and metadata when post-install verification fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-rollback-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const managedRoot = path.join(directory, 'managed')
    fs.mkdirSync(downloadDirectory)
    fs.mkdirSync(managedRoot)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const nextContent = Buffer.from('next-signed-test-binary')
    fs.writeFileSync(binaryPath, nextContent)
    const oldExecutable = Buffer.from('old-grok-binary')
    const oldAgent = Buffer.from('old-agent-binary')
    const oldMetadata = `${JSON.stringify({ version: '0.2.111', stable_version: '0.2.111' }, null, 2)}\n`
    fs.writeFileSync(path.join(managedRoot, 'grok.exe'), oldExecutable)
    fs.writeFileSync(path.join(managedRoot, 'agent.exe'), oldAgent)
    fs.writeFileSync(path.join(managedRoot, 'version.json'), oldMetadata, 'utf8')
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: nextContent.length,
      sha256Hex: createHash('sha256').update(nextContent).digest('hex'),
    }
    let verificationCount = 0
    const verifier = vi.fn(async (provider: string, filePath: string) => {
      verificationCount += 1
      if (verificationCount === 5) throw new Error('模拟 grok.exe 安装后签名校验失败')
      return fakeVerification(provider, filePath)
    })

    await expect(installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot,
      applyWindowsAcl: async () => undefined,
      verifyBinary: verifier,
    })).rejects.toThrow('模拟 grok.exe 安装后签名校验失败')

    expect(fs.readFileSync(path.join(managedRoot, 'grok.exe'))).toEqual(oldExecutable)
    expect(fs.readFileSync(path.join(managedRoot, 'agent.exe'))).toEqual(oldAgent)
    expect(fs.readFileSync(path.join(managedRoot, 'version.json'), 'utf8')).toBe(oldMetadata)
    expect(fs.readdirSync(managedRoot).filter((name) => /\.(?:pending\.(?:exe|json)|old)$/.test(name))).toEqual([])
  })

  it('restores the complete previous installation after a process crash', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-crash-'))
    temporaryDirectories.push(directory)
    const managedRoot = path.join(directory, 'managed')
    const transaction = path.join(managedRoot, '.grok-transaction-crashed')
    fs.mkdirSync(transaction, { recursive: true })
    const old = {
      'grok.exe': Buffer.from('old-grok'),
      'agent.exe': Buffer.from('old-agent'),
      'version.json': Buffer.from('{"version":"0.2.111"}\n'),
    }
    for (const [fileName, content] of Object.entries(old)) {
      fs.writeFileSync(path.join(managedRoot, fileName), `new-${fileName}`, 'utf8')
      fs.writeFileSync(path.join(transaction, `previous-${fileName}`), content)
    }
    fs.writeFileSync(path.join(transaction, 'transaction.json'), `${JSON.stringify({
      schemaVersion: 1,
      targets: Object.keys(old).map((fileName) => ({ fileName, hadExisting: true })),
    }, null, 2)}\n`, 'utf8')

    await expect(recoverInterruptedGrokInstallation(managedRoot, 'win32')).resolves.toBe(true)

    for (const [fileName, content] of Object.entries(old)) {
      expect(fs.readFileSync(path.join(managedRoot, fileName))).toEqual(content)
    }
    expect(fs.existsSync(transaction)).toBe(false)
  })

  it('preserves a failed rollback transaction and recovers it on the next attempt', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-rollback-failure-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const managedRoot = path.join(directory, 'managed')
    fs.mkdirSync(downloadDirectory)
    fs.mkdirSync(managedRoot)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const nextContent = Buffer.from('next-signed-test-binary')
    fs.writeFileSync(binaryPath, nextContent)
    const old = {
      'grok.exe': Buffer.from('old-grok-binary'),
      'agent.exe': Buffer.from('old-agent-binary'),
      'version.json': Buffer.from('{"version":"0.2.111"}\n'),
    }
    for (const [fileName, content] of Object.entries(old)) {
      fs.writeFileSync(path.join(managedRoot, fileName), content)
    }
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: nextContent.length,
      sha256Hex: createHash('sha256').update(nextContent).digest('hex'),
    }
    let verificationCount = 0
    const verifier = vi.fn(async (provider: string, filePath: string) => {
      verificationCount += 1
      if (verificationCount === 5) throw new Error('模拟提交后校验失败')
      return fakeVerification(provider, filePath)
    })
    let renameCount = 0
    const rename = vi.fn(async (source: string, destination: string) => {
      renameCount += 1
      if (renameCount === 7) throw new Error('模拟旧版元数据恢复失败')
      await fs.promises.rename(source, destination)
    })

    await expect(installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot,
      applyWindowsAcl: async () => undefined,
      verifyBinary: verifier,
      fileOperations: {
        rename,
        rm: (target, options) => fs.promises.rm(target, options),
      },
    })).rejects.toBeInstanceOf(GrokRollbackError)
    expect(fs.readdirSync(managedRoot).filter((name) => name.startsWith('.grok-transaction-')))
      .toHaveLength(1)

    await expect(recoverInterruptedGrokInstallation(managedRoot, 'win32')).resolves.toBe(true)
    for (const [fileName, content] of Object.entries(old)) {
      expect(fs.readFileSync(path.join(managedRoot, fileName))).toEqual(content)
    }
    expect(fs.readdirSync(managedRoot).filter((name) => name.startsWith('.grok-transaction-')))
      .toEqual([])
  })
})
