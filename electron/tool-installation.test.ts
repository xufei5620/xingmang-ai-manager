import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cliUninstallCapability,
  resolveCliCommand,
  resolveCliInstallation,
  resolveNpmGlobalRoot,
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

afterEach(() => {
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
      installDirectory: fs.realpathSync(bin),
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
      installDirectory: fs.realpathSync(userBin),
      source: 'native',
    })
  })

  it('normalizes a verified npm shim to node plus the package bin', async () => {
    const prefix = path.join(temporaryDirectory(), 'hermes', 'node')
    write(path.join(prefix, 'codex.cmd'))
    const node = write(path.join(prefix, 'node.exe'))
    const packageRoot = npmPackage(prefix, '@openai/codex', 'codex')

    const command = await resolveCliCommand('codex', { PATH: prefix })

    expect(command.executable).toBe(path.resolve(node))
    expect(command.argv).toEqual([fs.realpathSync(path.join(packageRoot, 'bin', 'codex.js'))])
  })

  it('rejects oversized package manifests before parsing them', () => {
    const packageRoot = path.join(temporaryDirectory(), 'oversized-package')
    write(path.join(packageRoot, 'package.json'), ' '.repeat(256 * 1024 + 1))

    expect(verifiedPackageRoot(packageRoot, '@openai/codex')).toBeNull()
  })
})
