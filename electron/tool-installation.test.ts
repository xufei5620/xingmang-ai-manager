import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeStagedDarwinCliRecords } from './darwin-cli-staging'
import type { DarwinCodexStandaloneSelection } from './macos-codex'
import {
  cliUninstallCapability,
  resolveCliCommand,
  resolveCliInstallation,
  resolveNpmGlobalRoot,
  runDarwinNativeVerificationCommand,
  verifiedPackageRoot,
} from './tool-installation'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-tool-installation-'))
  temporaryDirectories.push(directory)
  return directory
}

function write(filePath: string, content = ''): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o700)
  return filePath
}

function npmPackage(prefix: string, packageName: string, command: string): string {
  const packageRoot = path.join(prefix, 'node_modules', ...packageName.split('/'))
  write(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.2.3',
    bin: { [command]: `bin/${command}.js` },
  }))
  write(path.join(packageRoot, 'bin', `${command}.js`), '#!/usr/bin/env node\n')
  return packageRoot
}

function codexStandaloneFixture(options: { quotedPaths?: boolean; absoluteCodexHome?: boolean } = {}) {
  const root = temporaryDirectory()
  const home = path.join(root, options.quotedPaths ? "User's Home Folder" : 'home')
  const codexHome = options.absoluteCodexHome
    ? path.join(root, options.quotedPaths ? "Configured Codex Home's Folder" : 'configured-codex-home')
    : path.join(home, '.codex')
  const target = process.arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'
  const version = '0.146.0'
  const standaloneRoot = path.join(codexHome, 'packages', 'standalone')
  const releaseRoot = path.join(standaloneRoot, 'releases', `${version}-${target}`)
  const executablePath = write(path.join(releaseRoot, 'bin', 'codex'), '#!/bin/sh\n')
  write(path.join(releaseRoot, 'bin', 'codex-code-mode-host'), 'verified release host\n')
  write(path.join(releaseRoot, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version,
    target,
    variant: 'codex',
    entrypoint: 'bin/codex',
  }))
  const currentLink = path.join(standaloneRoot, 'current')
  fs.mkdirSync(path.dirname(currentLink), { recursive: true })
  fs.symlinkSync(path.join('releases', `${version}-${target}`), currentLink)

  const visibleCommand = path.join(home, '.local', 'bin', 'codex')
  const hostLink = path.join(home, '.local', 'bin', 'codex-code-mode-host')
  fs.mkdirSync(path.dirname(visibleCommand), { recursive: true })
  fs.symlinkSync(path.join(currentLink, 'bin', 'codex'), visibleCommand)
  const userOwnedHost = write(path.join(root, 'user-files', 'codex-code-mode-host'), 'user-owned host\n')
  fs.symlinkSync(userOwnedHost, hostLink)

  const unrelatedTarget = write(path.join(root, 'user-files', 'unrelated-helper'), 'user-owned helper\n')
  const unrelatedLink = path.join(home, '.local', 'bin', 'codex-user-helper')
  fs.symlinkSync(unrelatedTarget, unrelatedLink)
  fs.mkdirSync(path.join(home, '.Trash'), { recursive: true })

  return {
    codexHome,
    currentLink,
    executablePath,
    home,
    hostLink,
    releaseRoot,
    standaloneRoot,
    target,
    unrelatedLink,
    version,
    visibleCommand,
  }
}

function officialCodexResult(
  fixture: ReturnType<typeof codexStandaloneFixture>,
  spec: { executable: string; argv: readonly string[] },
): { stdout: string; stderr: string } {
  if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '-dv') {
    return {
      stdout: '',
      stderr: [
        'Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
        'TeamIdentifier=2DC432GLL2',
      ].join('\n'),
    }
  }
  if (spec.argv[0] === '--version') {
    return { stdout: `codex-cli ${fixture.version}\n`, stderr: '' }
  }
  return { stdout: '', stderr: '' }
}

async function verifiedStandalone(
  fixture: ReturnType<typeof codexStandaloneFixture>,
): Promise<{
  installation: NonNullable<Awaited<ReturnType<typeof resolveCliInstallation>>>
  selection: DarwinCodexStandaloneSelection
}> {
  const env = {
    HOME: fixture.home,
    PATH: path.dirname(fixture.visibleCommand),
    ...(fixture.codexHome !== path.join(fixture.home, '.codex')
      ? { CODEX_HOME: fixture.codexHome }
      : {}),
  }
  const installation = await resolveCliInstallation('codex', {
    env,
    executablePath: fixture.visibleCommand,
    npmGlobalRoot: path.join(fixture.home, 'missing-node-modules'),
    platform: 'darwin',
  })
  if (!installation) throw new Error('fixture installation was not resolved')
  const command = await resolveCliCommand('codex', env, 'trusted-only', {
    arch: process.arch,
    platform: 'darwin',
    runCommand: async (spec) => officialCodexResult(fixture, spec),
  })
  if (!command.verifiedDarwinStandalone) throw new Error('fixture was not verified')
  return { installation, selection: command.verifiedDarwinStandalone }
}

function linkedFileSnapshot(filePath: string) {
  const target = fs.readlinkSync(filePath)
  const content = fs.readFileSync(filePath, 'utf8')
  const stats = fs.lstatSync(filePath, { bigint: true })
  return {
    target,
    content,
    identity: {
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      size: stats.size,
      ctimeNs: stats.ctimeNs,
      mtimeNs: stats.mtimeNs,
    },
  }
}

afterEach(async () => {
  await disposeStagedDarwinCliRecords()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('CLI installation resolution', () => {
  it('only enables automatic npm uninstall for the managed prefix', () => {
    const installation = {
      commandPath: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
      installDirectory: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex',
      packageRoot: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex',
      npmPrefix: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
      source: 'npm' as const,
    }
    // 提权运行时用户级安装仍可卸载，但必须委派给以登录用户身份运行的窗口，
    // 否则包自带的卸载脚本会拿到管理员令牌。
    expect(cliUninstallCapability('codex', installation, {
      managedNpmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
      platform: 'win32',
    })).toEqual({
      available: true,
      delegated: true,
      reason: '当前为用户级或非托管 npm 安装，将以普通用户权限打开窗口执行卸载',
      manualCommand: 'npm uninstall -g @openai/codex',
    })

    expect(cliUninstallCapability('codex', {
      ...installation,
      commandPath: 'C:\\ProgramData\\XingMangAI\\Cli\\npm\\codex.cmd',
      installDirectory: 'C:\\ProgramData\\XingMangAI\\Cli\\npm\\node_modules\\@openai\\codex',
      packageRoot: 'C:\\ProgramData\\XingMangAI\\Cli\\npm\\node_modules\\@openai\\codex',
      npmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
    }, {
      managedNpmPrefix: 'c:\\programdata\\xingmangai\\cli\\npm\\',
      platform: 'win32',
    })).toEqual({ available: true, reason: null, manualCommand: null })
  })

  it('allows uninstalling a user-level npm install when the app is not elevated', () => {
    const installation = {
      commandPath: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd',
      installDirectory: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex',
      packageRoot: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex',
      npmPrefix: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
      source: 'npm' as const,
    }
    expect(cliUninstallCapability('codex', installation, {
      managedNpmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
      platform: 'win32',
      windowsExecutionMode: 'same-user',
    })).toEqual({ available: true, reason: null, manualCommand: null, delegated: false })

    // 未提权时直接执行即可，不需要委派——委派只为了甩掉管理员令牌。
    const elevated = cliUninstallCapability('codex', installation, {
      managedNpmPrefix: 'C:\\ProgramData\\XingMangAI\\Cli\\npm',
      platform: 'win32',
      windowsExecutionMode: 'trusted-only',
    })
    expect(elevated.available).toBe(true)
    expect(elevated.delegated).toBe(true)
  })

  it('keeps standard and app-managed native Grok directories uninstallable', () => {
    const installation = {
      commandPath: 'C:\\Users\\tester\\.grok\\bin\\grok.exe',
      installDirectory: 'C:\\Users\\tester\\.grok\\bin',
      packageRoot: null,
      npmPrefix: null,
      source: 'native' as const,
    }
    expect(cliUninstallCapability('grok', installation, {
      homeDirectory: 'C:\\Users\\tester',
      managedNativeDirectory: 'C:\\ProgramData\\XingMangAI\\Cli\\native\\grok',
      platform: 'win32',
    }).available).toBe(true)
    expect(cliUninstallCapability('grok', {
      ...installation,
      commandPath: 'C:\\ProgramData\\XingMangAI\\Cli\\native\\grok\\grok.exe',
      installDirectory: 'C:\\ProgramData\\XingMangAI\\Cli\\native\\grok',
    }, {
      homeDirectory: 'C:\\Users\\tester',
      managedNativeDirectory: 'c:\\programdata\\xingmangai\\cli\\native\\grok\\',
      platform: 'win32',
    }).available).toBe(true)
    expect(cliUninstallCapability('grok', {
      ...installation,
      installDirectory: 'D:\\portable\\grok',
    }, {
      homeDirectory: 'C:\\Users\\tester',
      platform: 'win32',
    })).toMatchObject({ available: false, manualCommand: null })
  })

  it.runIf(process.platform === 'darwin')('carries the fully verified standalone selection through native Codex command resolution', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(installation).toMatchObject({
      commandPath: fixture.visibleCommand,
      installDirectory: fs.realpathSync(path.dirname(fixture.visibleCommand)),
      source: 'native',
    })
    expect(selection).toMatchObject({
      requestedExecutablePath: fixture.visibleCommand,
      codexHome: fs.realpathSync(fixture.codexHome),
      releaseRoot: fs.realpathSync(fixture.releaseRoot),
      executablePath: fs.realpathSync(fixture.executablePath),
      target: fixture.target,
      version: fixture.version,
    })
    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: selection,
    }).manualCommand).toEqual(expect.any(String))
  })

  it.runIf(process.platform === 'darwin')('verifies the official canonical Grok selection before returning a native extension command', async () => {
    const home = temporaryDirectory()
    const bin = path.join(home, '.grok', 'bin')
    const executable = write(path.join(bin, 'grok-0.2.118'), '#!/bin/sh\n')
    const canonicalLink = path.join(bin, 'grok')
    fs.symlinkSync(path.basename(executable), canonicalLink)
    const specs: Array<{ executable: string; argv: readonly string[] }> = []

    const command = await resolveCliCommand('grok', {
      HOME: home,
      PATH: bin,
    }, 'trusted-only', {
      platform: 'darwin',
      runCommand: async (spec) => {
        specs.push(spec)
        if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '-dv') {
          return {
            stdout: '',
            stderr: [
              'Authority=Developer ID Application: X.AI Corporation (5Y6N3AJ54S)',
              'TeamIdentifier=5Y6N3AJ54S',
            ].join('\n'),
          }
        }
        if (spec.argv[0] === '--version') return { stdout: 'grok 0.2.118\n', stderr: '' }
        return { stdout: '', stderr: '' }
      },
    })

    expect(command.executable).not.toBe(fs.realpathSync(executable))
    expect(specs).toEqual([
      {
        executable: '/usr/bin/codesign',
        argv: [
          '--verify',
          '--strict',
          '-R=anchor apple generic'
            + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            + ' and certificate leaf[subject.OU] = "5Y6N3AJ54S"',
          command.executable,
        ],
      },
      { executable: command.executable, argv: ['--version'] },
    ])
  })

  it.runIf(process.platform === 'darwin')('fails closed when the canonical Grok signature cannot be verified', async () => {
    const home = temporaryDirectory()
    const bin = path.join(home, '.grok', 'bin')
    const executable = write(path.join(bin, 'grok-0.2.118'), '#!/bin/sh\n')
    fs.symlinkSync(path.basename(executable), path.join(bin, 'grok'))

    await expect(resolveCliCommand('grok', {
      HOME: home,
      PATH: bin,
    }, 'trusted-only', {
      platform: 'darwin',
      runCommand: async () => {
        throw new Error('invalid signature')
      },
      // The codesign failure is wrapped so the reported reason names the trust
      // decision rather than leaking a bare command error, with the original kept
      // as the cause.
    })).rejects.toThrow('Developer ID')
  })

  // resolveCliCommand's darwin cases above all inject a runCommand stub, since no
  // fixture binary here carries a real Developer ID signature codesign would accept.
  // That leaves the shipped default untested, exactly as it was before #37 — this
  // exercises it directly instead, the same way macos-codex-app.ts's equivalent fix
  // does for the Codex.app bundle scan.
  it.runIf(process.platform === 'darwin')('does not hand inherited injection variables to the darwin native verification command', async () => {
    const previousInsert = process.env.DYLD_INSERT_LIBRARIES
    const previousNodeOptions = process.env.NODE_OPTIONS
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/xingmang-not-a-real.dylib'
    process.env.NODE_OPTIONS = '--require /tmp/xingmang-not-a-real.js'
    process.env.XINGMANG_TOOL_INSTALLATION_SENTINEL = 'ordinary-value'
    try {
      const result = await runDarwinNativeVerificationCommand({ executable: '/usr/bin/env', argv: [] })

      // The variables that decide what a child loads before it runs are gone...
      expect(result.stdout).not.toContain('DYLD_INSERT_LIBRARIES')
      expect(result.stdout).not.toContain('xingmang-not-a-real.dylib')
      expect(result.stdout).not.toContain('NODE_OPTIONS')
      // ...while an ordinary variable still survives, proving the environment was
      // filtered rather than simply emptied.
      expect(result.stdout).toContain('XINGMANG_TOOL_INSTALLATION_SENTINEL=ordinary-value')
    } finally {
      delete process.env.XINGMANG_TOOL_INSTALLATION_SENTINEL
      if (previousInsert === undefined) delete process.env.DYLD_INSERT_LIBRARIES
      else process.env.DYLD_INSERT_LIBRARIES = previousInsert
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
    }
  })

  it.runIf(process.platform === 'darwin')('never executes a poisoned Grok source and fails closed on same-target link ABA', async () => {
    const home = temporaryDirectory()
    const bin = path.join(home, '.grok', 'bin')
    const marker = path.join(home, 'source-executed')
    const executable = write(path.join(bin, 'grok-0.2.118'), [
      '#!/bin/sh',
      `touch '${marker}'`,
      'printf "grok 0.2.118\\n"',
      '',
    ].join('\n'))
    const sourceExecutable = fs.realpathSync(executable)
    const canonicalLink = path.join(bin, 'grok')
    const target = path.basename(executable)
    fs.symlinkSync(target, canonicalLink)
    const specs: Array<{ executable: string; argv: readonly string[] }> = []
    let rebuilt = false

    await expect(resolveCliCommand('grok', {
      HOME: home,
      PATH: bin,
    }, 'trusted-only', {
      platform: 'darwin',
      darwinStagingRetention: 'ephemeral',
      runCommand: async (spec) => {
        if (spec.executable === sourceExecutable || spec.argv.includes(sourceExecutable)) {
          throw new Error('poisoned Grok source reached command execution')
        }
        specs.push(spec)
        if (!rebuilt && spec.executable === '/usr/bin/codesign' && spec.argv[0] === '--verify') {
          rebuilt = true
          fs.unlinkSync(canonicalLink)
          fs.symlinkSync(target, canonicalLink)
        }
        if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '-dv') {
          return {
            stdout: '',
            stderr: [
              'Authority=Developer ID Application: X.AI Corporation (5Y6N3AJ54S)',
              'TeamIdentifier=5Y6N3AJ54S',
            ].join('\n'),
          }
        }
        if (spec.argv[0] === '--version') return { stdout: 'grok 0.2.118\n', stderr: '' }
        return { stdout: '', stderr: '' }
      },
    })).rejects.toThrow(/发生变化/)

    const stagedExecutable = specs[0]?.argv.at(-1)
    expect(rebuilt).toBe(true)
    expect(stagedExecutable).toEqual(expect.any(String))
    expect(stagedExecutable).not.toBe(sourceExecutable)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.existsSync(path.dirname(stagedExecutable!))).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('returns a private Grok executable that is unchanged when the verified source is replaced later', async () => {
    const home = temporaryDirectory()
    const bin = path.join(home, '.grok', 'bin')
    const executable = write(path.join(bin, 'grok-0.2.118'), '#!/bin/sh\n')
    fs.symlinkSync(path.basename(executable), path.join(bin, 'grok'))
    const env = { HOME: home, PATH: bin }
    const command = await resolveCliCommand('grok', env, 'trusted-only', {
      platform: 'darwin',
      runCommand: async (spec) => {
        if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '-dv') {
          return {
            stdout: '',
            stderr: [
              'Authority=Developer ID Application: X.AI Corporation (5Y6N3AJ54S)',
              'TeamIdentifier=5Y6N3AJ54S',
            ].join('\n'),
          }
        }
        if (spec.argv[0] === '--version') return { stdout: 'grok 0.2.118\n', stderr: '' }
        return { stdout: '', stderr: '' }
      },
    })

    fs.writeFileSync(executable, '#!/bin/sh\necho replaced-source\n', { mode: 0o700 })
    const execution = spawnSync(command.executable, command.argv, { encoding: 'utf8', env })

    expect(command.executable).not.toBe(fs.realpathSync(executable))
    expect({ status: execution.status, stdout: execution.stdout }).toEqual({ status: 0, stdout: '' })
  })

  it.runIf(process.platform === 'darwin')('returns a private Codex executable that is unchanged when the verified source is replaced later', async () => {
    const fixture = codexStandaloneFixture()
    const env = { HOME: fixture.home, PATH: path.dirname(fixture.visibleCommand) }
    const specs: Array<{ executable: string; argv: readonly string[] }> = []
    const command = await resolveCliCommand('codex', env, 'trusted-only', {
      arch: process.arch,
      platform: 'darwin',
      darwinStagingRetention: 'ephemeral',
      runCommand: async (spec) => {
        specs.push(spec)
        return officialCodexResult(fixture, spec)
      },
    })

    fs.writeFileSync(fixture.executablePath, '#!/bin/sh\necho replaced-source\n', { mode: 0o700 })
    const execution = spawnSync(command.executable, command.argv, { encoding: 'utf8', env })

    expect(command.executable).not.toBe(fs.realpathSync(fixture.executablePath))
    expect({ status: execution.status, stdout: execution.stdout }).toEqual({ status: 0, stdout: '' })
    expect(specs).toEqual([
      {
        executable: '/usr/bin/codesign',
        argv: [
          '--verify',
          '--strict',
          '-R=anchor apple generic'
            + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            + ' and certificate leaf[subject.OU] = "2DC432GLL2"',
          command.executable,
        ],
      },
      { executable: command.executable, argv: ['--version'] },
    ])
    const stagedDirectory = path.dirname(command.executable)
    expect(command.release).toEqual(expect.any(Function))
    await command.release?.()
    expect(fs.existsSync(stagedDirectory)).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('moves only the verified Codex entry and standalone tree into one exclusive Trash directory', async () => {
    const fixture = codexStandaloneFixture({ quotedPaths: true, absoluteCodexHome: true })
    const { installation, selection } = await verifiedStandalone(fixture)
    const hostBefore = linkedFileSnapshot(fixture.hostLink)
    const unrelatedBefore = linkedFileSnapshot(fixture.unrelatedLink)
    const capability = cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: selection,
    })

    expect(capability).toMatchObject({
      available: false,
      reason: expect.stringContaining('standalone'),
      manualCommand: expect.any(String),
    })
    const result = spawnSync('/bin/sh', ['-c', capability.manualCommand!], {
      encoding: 'utf8',
      env: { HOME: fixture.home, PATH: path.join(fixture.home, 'poisoned-path') },
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })

    const trashEntries = fs.readdirSync(path.join(fixture.home, '.Trash'))
    expect(trashEntries).toHaveLength(1)
    const trashDirectory = path.join(fixture.home, '.Trash', trashEntries[0])
    expect(fs.statSync(trashDirectory).isDirectory()).toBe(true)
    expect(fs.readdirSync(trashDirectory).sort()).toEqual(['codex', 'standalone'])
    expect(fs.lstatSync(path.join(trashDirectory, 'codex')).isSymbolicLink()).toBe(true)
    expect(fs.statSync(path.join(trashDirectory, 'standalone')).isDirectory()).toBe(true)
    expect(fs.existsSync(fixture.visibleCommand)).toBe(false)
    expect(fs.existsSync(fixture.standaloneRoot)).toBe(false)
    expect(linkedFileSnapshot(fixture.hostLink)).toEqual(hostBefore)
    expect(linkedFileSnapshot(fixture.unrelatedLink)).toEqual(unrelatedBefore)
    expect(capability.manualCommand).not.toMatch(/\b(?:rm|sudo|spctl)\b|[*?\[\]]/)
  })

  it.runIf(process.platform === 'darwin')('does not trust a native executable without a complete verified standalone selection', async () => {
    const fixture = codexStandaloneFixture()
    const { installation } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
    })).toMatchObject({ available: false, manualCommand: null })
  })

  it.runIf(process.platform === 'darwin')('rejects an installation command path that differs from an otherwise valid verified selection', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', {
      ...installation,
      commandPath: path.join(fixture.home, '.local', 'bin', 'different-codex'),
    }, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: selection,
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a requested executable path that differs from an otherwise valid installation', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        requestedExecutablePath: path.join(fixture.home, '.local', 'bin', 'different-codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a relative Codex Home while all derived release paths remain consistent', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const codexHome = 'relative-codex-home'
    const releaseRoot = path.posix.join(
      codexHome,
      'packages',
      'standalone',
      'releases',
      `${selection.version}-${selection.target}`,
    )

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        codexHome,
        releaseRoot,
        executablePath: path.posix.join(releaseRoot, 'bin', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a NUL-containing Codex Home while all derived release paths remain consistent', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const codexHome = `${selection.codexHome}\0suffix`
    const releaseRoot = path.posix.join(
      codexHome,
      'packages',
      'standalone',
      'releases',
      `${selection.version}-${selection.target}`,
    )

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        codexHome,
        releaseRoot,
        executablePath: path.posix.join(releaseRoot, 'bin', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects an invalid version even when release and executable paths use that version', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const version = 'not-a-version'
    const releaseRoot = path.posix.join(
      selection.codexHome,
      'packages',
      'standalone',
      'releases',
      `${version}-${selection.target}`,
    )

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        version,
        releaseRoot,
        executablePath: path.posix.join(releaseRoot, 'bin', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects an invalid target even when release and executable paths use that target', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const target = 'aarch64-unknown-linux-gnu'
    const releaseRoot = path.posix.join(
      selection.codexHome,
      'packages',
      'standalone',
      'releases',
      `${selection.version}-${target}`,
    )

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        target,
        releaseRoot,
        executablePath: path.posix.join(releaseRoot, 'bin', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a verified selection whose entry is not bin/codex', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        executablePath: path.join(selection.releaseRoot, 'bin', 'codex-code-mode-host'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a verified selection outside packages/standalone/releases', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const wrongRelease = path.join(selection.codexHome, 'packages', 'releases', path.basename(selection.releaseRoot))

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        releaseRoot: wrongRelease,
        executablePath: path.join(wrongRelease, 'bin', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects current/bin even when it resolves to a verified release', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        releaseRoot: fixture.currentLink,
        executablePath: path.join(fixture.currentLink, 'bin', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects extra path components below a verified release', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        executablePath: path.join(selection.releaseRoot, 'bin', 'tools', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a target architecture inconsistent with the verified release directory', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const otherTarget = selection.target === 'aarch64-apple-darwin'
      ? 'x86_64-apple-darwin'
      : 'aarch64-apple-darwin'

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: { ...selection, target: otherTarget },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a version inconsistent with the verified release directory', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: { ...selection, version: '0.147.0' },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('rejects a verified release path that escapes Codex Home', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const escapedRelease = path.join(fixture.home, 'outside', path.basename(selection.releaseRoot))

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: {
        ...selection,
        releaseRoot: escapedRelease,
        executablePath: path.join(escapedRelease, 'bin', 'codex'),
      },
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('never offers a Darwin standalone command on another platform', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)

    expect(cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'linux',
      verifiedDarwinStandalone: selection,
    }).manualCommand).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('stops with a nonzero status before moving standalone when the Codex entry move fails', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const capability = cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: selection,
    })
    fs.unlinkSync(fixture.visibleCommand)

    const result = spawnSync('/bin/sh', ['-c', capability.manualCommand!], {
      encoding: 'utf8',
      env: { HOME: fixture.home, PATH: '' },
    })

    expect(result.status).not.toBe(0)
    expect(fs.statSync(fixture.standaloneRoot).isDirectory()).toBe(true)
    const trashEntries = fs.readdirSync(path.join(fixture.home, '.Trash'))
    expect(trashEntries).toHaveLength(1)
    expect(fs.readdirSync(path.join(fixture.home, '.Trash', trashEntries[0]))).toEqual([])
  })

  it.runIf(process.platform === 'darwin')('returns a nonzero status when moving the verified standalone tree fails', async () => {
    const fixture = codexStandaloneFixture()
    const { installation, selection } = await verifiedStandalone(fixture)
    const capability = cliUninstallCapability('codex', installation, {
      homeDirectory: fixture.home,
      platform: 'darwin',
      verifiedDarwinStandalone: selection,
    })
    const preservedStandalone = path.join(path.dirname(fixture.standaloneRoot), 'preserved-standalone')
    fs.renameSync(fixture.standaloneRoot, preservedStandalone)

    const result = spawnSync('/bin/sh', ['-c', capability.manualCommand!], {
      encoding: 'utf8',
      env: { HOME: fixture.home, PATH: '' },
    })

    expect(result.status).not.toBe(0)
    expect(fs.statSync(preservedStandalone).isDirectory()).toBe(true)
    const trashEntries = fs.readdirSync(path.join(fixture.home, '.Trash'))
    expect(trashEntries).toHaveLength(1)
    const trashDirectory = path.join(fixture.home, '.Trash', trashEntries[0])
    expect(fs.readdirSync(trashDirectory)).toEqual(['codex'])
    expect(fs.lstatSync(path.join(trashDirectory, 'codex')).isSymbolicLink()).toBe(true)
  })

  it('does not invent a command for an unknown native Codex layout', () => {
    expect(cliUninstallCapability('codex', {
      commandPath: '/opt/custom/codex',
      installDirectory: '/opt/custom',
      packageRoot: null,
      npmPrefix: null,
      source: 'native',
    }, {
      homeDirectory: '/Users/tester',
      platform: 'darwin',
    })).toMatchObject({ available: false, manualCommand: null })
  })

  it('derives the Windows npm root without executing npm from the elevated process', async () => {
    const queryNpmRoot = vi.fn(async () => 'must-not-run')
    await expect(resolveNpmGlobalRoot(
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\npm.cmd',
      {},
      queryNpmRoot,
      'win32',
    )).resolves.toBe('C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules')
    expect(queryNpmRoot).not.toHaveBeenCalled()
  })

  it('finds a Codex package beside a Hermes npm shim', async () => {
    const prefix = path.join(temporaryDirectory(), 'hermes', 'node')
    const commandPath = write(path.join(prefix, 'codex.cmd'), '@echo off\n')
    const packageRoot = npmPackage(prefix, '@openai/codex', 'codex')

    await expect(resolveCliInstallation('codex', {
      env: { PATH: prefix },
      executablePath: commandPath,
      npmGlobalRoot: path.join(prefix, 'node_modules'),
    })).resolves.toMatchObject({
      commandPath: path.resolve(commandPath),
      installDirectory: fs.realpathSync(packageRoot),
      packageRoot: fs.realpathSync(packageRoot),
      npmPrefix: path.resolve(prefix),
      packageVersion: '1.2.3',
      source: 'npm',
    })
  })

  it('uses APPDATA and npm_config_prefix package roots', async () => {
    const home = temporaryDirectory()
    const appDataPrefix = path.join(home, 'AppData', 'Roaming', 'npm')
    const customPrefix = path.join(home, 'custom-node')
    const codexCommand = write(path.join(appDataPrefix, 'codex.cmd'))
    const geminiCommand = write(path.join(customPrefix, 'gemini.cmd'))
    const codexRoot = npmPackage(appDataPrefix, '@openai/codex', 'codex')
    const geminiRoot = npmPackage(customPrefix, '@google/gemini-cli', 'gemini')

    await expect(resolveCliInstallation('codex', {
      env: { PATH: appDataPrefix, APPDATA: path.join(home, 'AppData', 'Roaming') },
      executablePath: codexCommand,
      npmGlobalRoot: path.join(appDataPrefix, 'missing-root'),
    })).resolves.toMatchObject({ packageRoot: fs.realpathSync(codexRoot), source: 'npm' })
    await expect(resolveCliInstallation('gemini', {
      env: { PATH: customPrefix, npm_config_prefix: customPrefix },
      executablePath: geminiCommand,
      npmGlobalRoot: path.join(customPrefix, 'missing-root'),
    })).resolves.toMatchObject({ packageRoot: fs.realpathSync(geminiRoot), source: 'npm' })
  })

  it('falls back to the native Grok executable directory', async () => {
    const bin = path.join(temporaryDirectory(), '.grok', 'bin')
    const executable = write(path.join(bin, 'grok.exe'))

    await expect(resolveCliInstallation('grok', {
      env: { PATH: bin },
      executablePath: executable,
      npmGlobalRoot: path.join(bin, 'missing-node-modules'),
    })).resolves.toMatchObject({
      commandPath: path.resolve(executable),
      installDirectory: fs.realpathSync.native(bin),
      packageRoot: null,
      source: 'native',
    })
  })

  it('prefers an explicitly installed Grok executable over an older PATH copy', async () => {
    const directory = temporaryDirectory()
    const oldBin = path.join(directory, 'managed', 'grok')
    const userBin = path.join(directory, 'home', '.grok', 'bin')
    write(path.join(oldBin, 'grok.exe'))
    const installedExecutable = write(path.join(userBin, 'grok.exe'))

    await expect(resolveCliInstallation('grok', {
      env: { PATH: oldBin },
      executablePath: installedExecutable,
      npmGlobalRoot: path.join(directory, 'missing-node-modules'),
      platform: 'win32',
    })).resolves.toMatchObject({
      commandPath: path.resolve(installedExecutable),
      installDirectory: fs.realpathSync.native(userBin),
      source: 'native',
    })
  })

  it('executes the native Claude package bin directly on macOS despite its .exe suffix', async () => {
    const directory = temporaryDirectory()
    const prefix = path.join(directory, 'Cli', 'npm')
    const binDirectory = path.join(prefix, 'bin')
    const commandPath = write(path.join(binDirectory, 'claude'), '#!/bin/sh\n')
    const packageRoot = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-code',
      version: '2.1.251',
      bin: { claude: 'bin/claude.exe' },
    }))
    const nativeBin = path.join(packageRoot, 'bin', 'claude.exe')
    fs.mkdirSync(path.dirname(nativeBin), { recursive: true })
    fs.writeFileSync(nativeBin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]), { mode: 0o700 })

    const command = await resolveCliCommand('claude', {
      HOME: directory,
      PATH: binDirectory,
    }, 'same-user', { platform: 'darwin', executablePath: commandPath })

    expect(command).toEqual({
      executable: fs.realpathSync(nativeBin),
      argv: [],
    })
    expect(command.executable).not.toBe(process.execPath)
    expect(command.argv).not.toContain(fs.realpathSync(nativeBin))
    expect(commandPath).toBeTruthy()
  })

  it('uses Claude Code cli-wrapper.cjs when the native optional dependency is missing', async () => {
    const directory = temporaryDirectory()
    const prefix = path.join(directory, 'Cli', 'npm')
    const binDirectory = path.join(prefix, 'bin')
    write(path.join(binDirectory, 'claude'), '#!/bin/sh\n')
    write(path.join(binDirectory, 'node'), '#!/bin/sh\n')
    const packageRoot = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-code',
      version: '2.1.251',
      bin: { claude: 'bin/claude.exe' },
    }))
    write(path.join(packageRoot, 'bin', 'claude.exe'), 'echo "native binary not installed"\n')
    const fallback = write(path.join(packageRoot, 'cli-wrapper.cjs'), '#!/usr/bin/env node\n')

    const command = await resolveCliCommand('claude', {
      HOME: directory,
      PATH: binDirectory,
    }, 'same-user', { platform: 'darwin', executablePath: path.join(binDirectory, 'claude') })

    expect(command).toEqual({
      executable: path.resolve(path.join(binDirectory, 'node')),
      argv: [fs.realpathSync(fallback)],
    })
  })

  it('normalizes a verified npm shim to node plus the package bin', async () => {
    const directory = temporaryDirectory()
    const prefix = path.join(directory, 'hermes', 'node')
    write(path.join(prefix, process.platform === 'win32' ? 'codex.cmd' : 'codex'))
    const node = write(path.join(prefix, process.platform === 'win32' ? 'node.exe' : 'node'))
    const packageRoot = npmPackage(prefix, '@openai/codex', 'codex')

    const command = await resolveCliCommand('codex', { PATH: prefix, HOME: directory })

    expect(command.executable).toBe(path.resolve(node))
    expect(command.argv).toEqual([fs.realpathSync(path.join(packageRoot, 'bin', 'codex.js'))])
  })

  it('rejects oversized package manifests before parsing them', () => {
    const packageRoot = path.join(temporaryDirectory(), 'oversized-package')
    write(path.join(packageRoot, 'package.json'), ' '.repeat(256 * 1024 + 1))

    expect(verifiedPackageRoot(packageRoot, '@openai/codex')).toBeNull()
  })
})
