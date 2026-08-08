import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  CommandRunnerError,
  cleanCommandOutput,
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  isUserWritablePath,
  runCommand,
  runWithTrustedWindowsProcessEnvironment,
  trustedCommandEnvironment,
  windowsSystemExecutable,
} from './command-runner'
import type { WindowsMachinePaths } from './windows-machine-paths'

const testMachinePaths: WindowsMachinePaths = {
  systemRoot: 'D:\\Windows',
  system32: 'D:\\Windows\\System32',
  programFiles: 'D:\\Program Files',
  programFilesX86: 'D:\\Program Files (x86)',
  programData: 'D:\\ProgramData',
}

const nodeCommand = (script: string, ...argv: string[]) => ({
  executable: process.execPath,
  argv: ['-e', script, '--', ...argv],
})

function createFakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    killSignals: Array<NodeJS.Signals | number | undefined>
    kill: (signal?: NodeJS.Signals | number) => boolean
    unref: () => unknown
  }
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killSignals = []
  child.kill = (signal) => {
    child.killSignals.push(signal)
    queueMicrotask(() => {
      child.emit('exit', null, typeof signal === 'string' ? signal : null)
      child.emit('close', null, typeof signal === 'string' ? signal : null)
    })
    return true
  }
  child.unref = () => child
  return child
}

describe('secure command runner', () => {
  it('keeps user-scoped tools discoverable but outside the high-integrity execution boundary', () => {
    const executable = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node.exe'
    expect(isTrustedHighIntegrityExecutable(executable, {
      USERPROFILE: 'C:\\Users\\tester',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
    }, 'win32')).toBe(false)
    expect(isTrustedHighIntegrityExecutable('node.exe', {}, 'win32')).toBe(false)
    expect(isTrustedHighIntegrityExecutable('/home/tester/bin/node', {}, 'linux')).toBe(true)
  })

  it('passes spaces and shell metacharacters as literal argv values', async () => {
    const argv = ['space value', 'amp&pipe|redirect<>caret^percent%bang!', 'quote"single\'']
    const result = await runCommand({
      executable: process.execPath,
      argv: ['-p', 'JSON.stringify(process.argv.slice(1))', '--', ...argv],
    })

    expect(JSON.parse(result.stdout)).toEqual(argv)
    expect(result.exitCode).toBe(0)
  })

  it('terminates commands after the configured timeout', async () => {
    const execution = runCommand(nodeCommand('setInterval(() => {}, 1_000)'), {
      timeoutMs: 40,
      killGraceMs: 20,
    })

    await expect(execution).rejects.toMatchObject({
      name: 'CommandRunnerError',
      code: 'TIMED_OUT',
    })
  })

  it('settles after exit even when inherited stdio pipes stay open', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' }).unref()",
      "process.stdout.write('parent-done')",
    ].join(';')
    const result = await runCommand(nodeCommand(script), {
      timeoutMs: 10_000,
      killGraceMs: 200,
    })

    expect(result.stdout).toContain('parent-done')
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeLessThan(5_000)
  }, 9_000)

  it('stops reading and terminates when combined output exceeds the byte limit', async () => {
    const execution = runCommand(nodeCommand("process.stdout.write('x'.repeat(16_384))"), {
      maxOutputBytes: 128,
    })

    try {
      await execution
      throw new Error('Expected output limit failure')
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRunnerError)
      expect(error).toMatchObject({ code: 'OUTPUT_LIMIT', maxOutputBytes: 128 })
      expect((error as CommandRunnerError).stdout).toHaveLength(128)
      expect((error as CommandRunnerError).outputBytes).toBeGreaterThan(128)
    }
  })

  it('supports AbortSignal cancellation', async () => {
    const controller = new AbortController()
    const execution = runCommand(nodeCommand('setInterval(() => {}, 1_000)'), {
      signal: controller.signal,
      timeoutMs: 2_000,
      killGraceMs: 20,
    })
    setTimeout(() => controller.abort(), 30)

    await expect(execution).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('falls back to direct child termination when taskkill exits nonzero', async () => {
    const primary = createFakeChild(101)
    const killer = createFakeChild(202)
    let spawnCount = 0
    const spawnProcess = (() => {
      spawnCount += 1
      if (spawnCount === 1) return primary
      queueMicrotask(() => killer.emit('exit', 1, null))
      return killer
    }) as unknown as typeof import('node:child_process').spawn

    const execution = runCommand(nodeCommand('setInterval(() => {}, 1_000)'), {
      timeoutMs: 10,
      killGraceMs: 100,
    }, {
      platform: 'win32',
      spawnProcess,
      resolveWindowsSystemExecutable: () => 'D:\\Windows\\System32\\taskkill.exe',
    })

    await expect(execution).rejects.toMatchObject({ code: 'TIMED_OUT' })
    expect(primary.killSignals).toEqual(['SIGTERM'])
  })

  it('settles after confirmed exit when inherited pipes never emit child close', async () => {
    const primary = createFakeChild(303)
    const spawnProcess = (() => {
      queueMicrotask(() => {
        primary.stdout.write('fake-output')
        primary.emit('exit', 0, null)
      })
      return primary
    }) as unknown as typeof import('node:child_process').spawn
    let guard: NodeJS.Timeout | undefined

    try {
      const result = await Promise.race([
        runCommand(nodeCommand("process.stdout.write('real-output')"), {
          timeoutMs: 0,
          killGraceMs: 10,
        }, {
          platform: 'linux',
          spawnProcess,
        }),
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error('runCommand remained pending after child exit')), 100)
        }),
      ])

      expect(result.stdout).toBe('fake-output')
      expect(result.exitCode).toBe(0)
    } finally {
      if (guard) clearTimeout(guard)
    }
  })

  it('cleans ANSI output and redacts credentials from structured errors', async () => {
    const apiKey = 'sk-ultra-secret-value'
    const execution = runCommand(nodeCommand([
      "process.stderr.write('\\u001b[31mAuthorization: Bearer bearer-secret-token\\u001b[0m\\n')",
      `process.stderr.write('api_key=${apiKey}\\n')`,
      'process.exit(7)',
    ].join(';')), { sensitiveValues: [apiKey] })

    try {
      await execution
      throw new Error('Expected non-zero exit failure')
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRunnerError)
      const structured = (error as CommandRunnerError).toJSON()
      expect(structured.code).toBe('EXIT_NON_ZERO')
      expect(structured.stderr).not.toContain(apiKey)
      expect(structured.stderr).not.toContain('bearer-secret-token')
      expect(structured.stderr).not.toContain('\u001b')
      expect(structured.stderr).toContain('[REDACTED]')
      expect(JSON.stringify(structured)).not.toContain(apiKey)
    }
  })

  it('resolves executables without a locator shell and builds a stable PATH', async () => {
    const environment = commandEnvironment({ PATH: process.env.PATH }, [process.execPath.replace(/[\\/][^\\/]+$/, '')])
    const executable = await findExecutable(process.platform === 'win32' ? 'node.exe' : 'node', { env: environment })

    expect(executable).not.toBeNull()
    expect(environment.PATH?.split(process.platform === 'win32' ? ';' : ':')[0]).toBeTruthy()
  })

  it.runIf(process.platform === 'darwin')('orders deterministic macOS command paths before inherited PATH entries', () => {
    const environment = commandEnvironment({
      PATH: '/usr/bin:/custom/inherited:/opt/homebrew/bin',
    }, ['/managed/bin', '/usr/local/bin'])

    // System directories precede every writable one, so a user-scoped file named
    // git or python3 cannot displace the copy macOS ships. Caller-supplied paths
    // stay ahead of both: those are already-resolved directories, not guesses.
    expect(environment.PATH?.split(':')).toEqual([
      '/managed/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      `${os.homedir()}/Library/Application Support/XingMangAI/Cli/npm/bin`,
      `${os.homedir()}/.grok/bin`,
      `${os.homedir()}/.local/bin`,
      `${os.homedir()}/.volta/bin`,
      `${os.homedir()}/.cargo/bin`,
      `${os.homedir()}/.npm-global/bin`,
      `${os.homedir()}/Library/pnpm`,
      '/opt/homebrew/bin',
      '/custom/inherited',
    ])
  })

  it.runIf(process.platform === 'darwin')('uses the supplied HOME for deterministic macOS user paths', () => {
    const environment = commandEnvironment({
      HOME: '/Users/isolated-test-user',
      PATH: '/usr/bin',
    })

    const entries = environment.PATH?.split(':') ?? []
    expect(entries.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(entries.slice(4, 10)).toEqual([
      '/Users/isolated-test-user/Library/Application Support/XingMangAI/Cli/npm/bin',
      '/Users/isolated-test-user/.grok/bin',
      '/Users/isolated-test-user/.local/bin',
      '/Users/isolated-test-user/.volta/bin',
      '/Users/isolated-test-user/.cargo/bin',
      '/Users/isolated-test-user/.npm-global/bin',
    ])
    expect(environment.PATH).not.toContain(os.homedir())
  })

  it.runIf(process.platform === 'darwin')('resolves a system-provided command from /usr/bin instead of a user-scoped file of the same name', async () => {
    // The threat this ordering closes: anything able to write the user's own bin
    // directory — a postinstall script, an unpacked archive — could otherwise put a
    // file named git there and have it resolved ahead of the copy macOS ships.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-shadowed-home-'))
    try {
      const shadowDirectory = path.join(home, '.local', 'bin')
      fs.mkdirSync(shadowDirectory, { recursive: true })
      const shadow = path.join(shadowDirectory, 'git')
      fs.writeFileSync(shadow, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const resolved = await findExecutable('git', {
        env: commandEnvironment({ HOME: home, PATH: '' }),
      })

      expect(resolved).toBe('/usr/bin/git')
      expect(resolved).not.toBe(shadow)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('adds common Windows Node manager and package-manager paths', () => {
    const environment = commandEnvironment({
      PATH: 'C:\\Windows\\System32',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\tester',
      NVM_SYMLINK: 'D:\\nodejs',
      FNM_MULTISHELL_PATH: 'C:\\Users\\tester\\AppData\\Local\\fnm_multishells\\123',
      VOLTA_HOME: 'C:\\Users\\tester\\AppData\\Local\\Volta',
      ChocolateyInstall: 'C:\\ProgramData\\chocolatey',
      ProgramData: 'C:\\ProgramData',
      ProgramFiles: 'C:\\Program Files',
      ProgramW6432: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    })
    const entries = environment.PATH?.split(';') ?? []

    expect(entries).toEqual(expect.arrayContaining([
      'C:\\Users\\tester\\AppData\\Roaming\\npm',
      'D:\\nodejs',
      'C:\\Users\\tester\\AppData\\Local\\fnm_multishells\\123',
      'C:\\Users\\tester\\AppData\\Local\\Volta\\bin',
      'C:\\Users\\tester\\.volta\\bin',
      'C:\\Users\\tester\\scoop\\shims',
      'C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs',
      'C:\\ProgramData\\chocolatey\\bin',
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs',
    ]))
    expect(entries.filter((entry) => entry === 'C:\\ProgramData\\chocolatey\\bin')).toHaveLength(1)
    expect(entries.filter((entry) => entry === 'C:\\Program Files\\nodejs')).toHaveLength(1)
  })

  it('removes interpreter, PowerShell, npm and Git injection variables from trusted environments', () => {
    const environment = trustedCommandEnvironment({
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      NODE_OPTIONS: '--require=C:\\Users\\tester\\payload.js',
      npm_config_prefix: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
      npm_config_script_shell: 'C:\\Users\\tester\\evil.cmd',
      npm_lifecycle_script: 'C:\\Users\\tester\\payload.js',
      NODE_EXTRA_CA_CERTS: 'C:\\Users\\tester\\fake-ca.pem',
      COMSPEC: 'C:\\Users\\tester\\evil.cmd',
      PSModulePath: 'C:\\Users\\tester\\Documents\\WindowsPowerShell\\Modules',
      PSModuleAnalysisCachePath: 'C:\\Users\\tester\\module-cache',
      PSExecutionPolicyPreference: 'Bypass',
      DOTNET_STARTUP_HOOKS: 'C:\\Users\\tester\\startup-hook.dll',
      DoTnEt_RoOt_X64: 'C:\\Users\\tester\\fake-dotnet',
      CORECLR_ENABLE_PROFILING: '1',
      CORECLR_PROFILER_PATH: 'C:\\Users\\tester\\profiler.dll',
      COREHOST_TRACEFILE: 'C:\\Users\\tester\\host-trace.txt',
      COR_ENABLE_PROFILING: '1',
      COMPlus_ReadyToRun: '0',
      ELECTRON_RUN_AS_NODE: '1',
      LD_PRELOAD: '/home/tester/payload.so',
      DYLD_INSERT_LIBRARIES: '/Users/tester/payload.dylib',
      JAVA_TOOL_OPTIONS: '-javaagent:C:\\Users\\tester\\agent.jar',
      JDK_JAVA_OPTIONS: '-XX:OnError=C:\\Users\\tester\\payload.exe',
      _JAVA_OPTIONS: '-Xbootclasspath/a:C:\\Users\\tester\\payload.jar',
      CLASSPATH: 'C:\\Users\\tester\\classes',
      PERL5OPT: '-Mpayload',
      PERL5DB: 'BEGIN { system q(payload.exe) }',
      PERLLIB: 'C:\\Users\\tester\\perl',
      PYTHONSTARTUP: 'C:\\Users\\tester\\startup.py',
      PYTHONINSPECT: '1',
      PYTHONBREAKPOINT: 'payload.run',
      PYTHONUSERBASE: 'C:\\Users\\tester\\python',
      ENV: 'C:\\Users\\tester\\shell-init',
      ZDOTDIR: 'C:\\Users\\tester\\zsh',
      BROWSER: 'C:\\Users\\tester\\browser.cmd',
      PAGER: 'C:\\Users\\tester\\pager.cmd',
      EDITOR: 'C:\\Users\\tester\\editor.cmd',
      GIT_EXEC_PATH: 'C:\\Users\\tester\\git-core',
      GIT_SSH_COMMAND: 'C:\\Users\\tester\\evil-ssh.cmd',
      GIT_CONFIG_COUNT: '1',
      SSH_ASKPASS: 'C:\\Users\\tester\\askpass.exe',
      XINGMANG_TEST_VALUE: 'kept',
    })
    expect(environment.NODE_OPTIONS).toBeUndefined()
    expect(environment.npm_config_prefix).toBeUndefined()
    expect(environment.npm_config_script_shell).toBeUndefined()
    expect(environment.npm_lifecycle_script).toBeUndefined()
    expect(environment.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(environment.COMSPEC).toBeUndefined()
    expect(environment.PSModuleAnalysisCachePath).toBeUndefined()
    expect(environment.PSExecutionPolicyPreference).toBeUndefined()
    expect(environment.DOTNET_STARTUP_HOOKS).toBeUndefined()
    expect(environment.DoTnEt_RoOt_X64).toBeUndefined()
    expect(environment.CORECLR_ENABLE_PROFILING).toBeUndefined()
    expect(environment.CORECLR_PROFILER_PATH).toBeUndefined()
    expect(environment.COREHOST_TRACEFILE).toBeUndefined()
    expect(environment.COR_ENABLE_PROFILING).toBeUndefined()
    expect(environment.COMPlus_ReadyToRun).toBeUndefined()
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(environment.LD_PRELOAD).toBeUndefined()
    expect(environment.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(environment.JAVA_TOOL_OPTIONS).toBeUndefined()
    expect(environment.JDK_JAVA_OPTIONS).toBeUndefined()
    expect(environment._JAVA_OPTIONS).toBeUndefined()
    expect(environment.CLASSPATH).toBeUndefined()
    expect(environment.PERL5OPT).toBeUndefined()
    expect(environment.PERL5DB).toBeUndefined()
    expect(environment.PERLLIB).toBeUndefined()
    expect(environment.PYTHONSTARTUP).toBeUndefined()
    expect(environment.PYTHONINSPECT).toBeUndefined()
    expect(environment.PYTHONBREAKPOINT).toBeUndefined()
    expect(environment.PYTHONUSERBASE).toBeUndefined()
    expect(environment.ENV).toBeUndefined()
    expect(environment.ZDOTDIR).toBeUndefined()
    expect(environment.BROWSER).toBeUndefined()
    expect(environment.PAGER).toBeUndefined()
    expect(environment.EDITOR).toBeUndefined()
    expect(environment.PYTHONNOUSERSITE).toBe('1')
    expect(environment.PYTHONSAFEPATH).toBe('1')
    if (process.platform === 'win32') {
      expect(environment.PSModulePath).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
      expect(environment.PSModulePath).not.toContain('C:\\Users\\tester')
      expect(environment.PATH).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    } else if (process.platform === 'darwin') {
      expect(environment.PSModulePath).toBeUndefined()
      // The caller's PATH is no longer carried over verbatim. This entry is not an
      // absolute POSIX path, so it cannot survive the rebuild, while the fixed system
      // directories always do.
      expect(environment.PATH).not.toContain('C:\\Windows\\System32')
      expect(environment.PATH?.split(path.posix.delimiter)).toContain('/usr/bin')
    } else {
      expect(environment.PSModulePath).toBeUndefined()
      expect(environment.PATH).toBe('C:\\Windows\\System32')
    }
    expect(environment.GIT_EXEC_PATH).toBeUndefined()
    expect(environment.GIT_SSH_COMMAND).toBeUndefined()
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined()
    expect(environment.SSH_ASKPASS).toBeUndefined()
    expect(environment.XINGMANG_TEST_VALUE).toBe('kept')
  })

  it('retains only fixed non-executable Git isolation controls', () => {
    const environment = trustedCommandEnvironment({
      PATH: 'C:\\Windows\\System32',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: 'NUL',
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_SSH_COMMAND: 'C:\\Users\\tester\\evil.cmd',
    })

    expect(environment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: 'NUL',
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
    })
    expect(environment.GIT_SSH_COMMAND).toBeUndefined()
    expect(trustedCommandEnvironment({ GIT_CONFIG_COUNT: '1' }).GIT_CONFIG_COUNT).toBeUndefined()
    expect(trustedCommandEnvironment({ GIT_CONFIG_GLOBAL: 'C:\\Users\\tester\\.gitconfig' }).GIT_CONFIG_GLOBAL)
      .toBeUndefined()
  })

  it('replaces polluted machine environment variables with independently resolved roots', () => {
    const environment = trustedCommandEnvironment({
      PATH: 'E:\\attacker\\bin;C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps',
      SystemRoot: 'E:\\attacker\\Windows',
      WINDIR: 'E:\\attacker\\Windows',
      ProgramFiles: 'E:\\attacker\\Program Files',
      ProgramW6432: 'E:\\attacker\\Program Files',
      ProgramData: 'E:\\attacker\\ProgramData',
      PROGRAMDATA: 'E:\\attacker\\ProgramData-duplicate',
    }, testMachinePaths)

    expect(environment.SystemRoot).toBe(testMachinePaths.systemRoot)
    expect(environment.ProgramFiles).toBe(testMachinePaths.programFiles)
    expect(environment.ProgramData).toBe(testMachinePaths.programData)
    expect(environment.PROGRAMDATA).toBe(testMachinePaths.programData)
    expect(environment.PATH).not.toContain('attacker')
    expect(environment.PATH).not.toContain('WindowsApps')
  })

  it('constructs PSModulePath from canonical System32 without probing Program Files', () => {
    const canonicalModules = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
    const environment = trustedCommandEnvironment({}, testMachinePaths, 'win32', {
      isTrustedMachinePath: (candidate) => {
        if (candidate.toLowerCase().startsWith(testMachinePaths.programFiles.toLowerCase())) {
          throw new Error('Program Files ACL lookup must not run while constructing PSModulePath')
        }
        return candidate.toLowerCase() === canonicalModules.toLowerCase()
      },
    })

    expect(environment.PSModulePath).toBe(canonicalModules)
  })

  it.runIf(process.platform === 'win32')('temporarily sanitizes and exactly restores installer spawn environments', () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: 'C:\\Users\\tester\\bin',
      NODE_OPTIONS: '--require=C:\\Users\\tester\\payload.js',
      DOTNET_STARTUP_HOOKS: 'C:\\Users\\tester\\payload.dll',
      XINGMANG_TEST_VALUE: 'kept',
    }
    let captured: NodeJS.ProcessEnv | null = null

    runWithTrustedWindowsProcessEnvironment(() => {
      captured = { ...environment }
    }, environment, testMachinePaths)

    expect(captured?.NODE_OPTIONS).toBeUndefined()
    expect(captured?.DOTNET_STARTUP_HOOKS).toBeUndefined()
    expect(captured?.PATH).not.toContain('C:\\Users\\tester')
    expect(captured?.XINGMANG_TEST_VALUE).toBe('kept')
    expect(environment).toEqual({
      PATH: 'C:\\Users\\tester\\bin',
      NODE_OPTIONS: '--require=C:\\Users\\tester\\payload.js',
      DOTNET_STARTUP_HOOKS: 'C:\\Users\\tester\\payload.dll',
      XINGMANG_TEST_VALUE: 'kept',
    })
  })

  it('removes common CSI and OSC ANSI sequences', () => {
    expect(cleanCommandOutput('\u001b]0;title\u0007\u001b[32mok\u001b[0m')).toBe('ok')
  })

  it('resolves Windows inbox tools from System32 without PATH lookup', () => {
    expect(windowsSystemExecutable('cmd.exe', {
      SystemRoot: 'E:\\attacker\\Windows',
      PATH: 'C:\\Users\\tester\\bin',
    }, 'win32', testMachinePaths)).toBe('D:\\Windows\\System32\\cmd.exe')
    expect(() => windowsSystemExecutable('..\\cmd.exe', {}, 'win32')).toThrow('文件名无效')
    expect(windowsSystemExecutable('sh', {}, 'linux')).toBe('sh')
  })

  it('uses the default cached machine-path resolver for the current Windows platform', () => {
    const resolveMachinePaths = (options?: { platform?: NodeJS.Platform }) => {
      if (options !== undefined) throw new Error('current-platform resolution bypassed the default cache')
      return testMachinePaths
    }

    expect(windowsSystemExecutable('taskkill.exe', {}, 'win32', undefined, {
      currentPlatform: 'win32',
      resolveMachinePaths,
    })).toBe('D:\\Windows\\System32\\taskkill.exe')
    expect(windowsSystemExecutable('where.exe', {}, 'win32', undefined, {
      currentPlatform: 'win32',
      resolveMachinePaths,
    })).toBe('D:\\Windows\\System32\\where.exe')
  })

  it.runIf(process.platform === 'win32')('blocks arbitrary Windows command shims', async () => {
    await expect(runCommand({
      executable: 'C:\\untrusted folder\\tool.cmd',
      argv: ['--version'],
    })).rejects.toMatchObject({ code: 'UNSAFE_COMMAND' })
  })

  it.runIf(process.platform === 'win32')('blocks user-writable targets for trusted commands', async () => {
    await expect(runCommand({
      executable: 'C:\\Users\\tester\\AppData\\Local\\Temp\\xingmang-shim.exe',
      argv: [],
    }, { trustedOnly: true })).rejects.toMatchObject({ code: 'UNSAFE_COMMAND' })
  })

  it.runIf(process.platform === 'win32')('blocks user-writable installer inputs for trusted commands', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-input-'))
    const input = path.join(directory, 'installer.msi')
    fs.writeFileSync(input, 'test', 'utf8')
    try {
      await expect(runCommand({
        executable: process.execPath,
        argv: ['--version'],
      }, {
        trustedOnly: true,
        trustedPaths: [input],
      })).rejects.toMatchObject({ code: 'UNSAFE_COMMAND' })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('blocks user-writable paths embedded in trusted command options and response files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-trusted-argument-'))
    const input = path.join(directory, 'payload.js')
    fs.writeFileSync(input, 'test', 'utf8')
    try {
      const executable = windowsSystemExecutable('where.exe')
      for (const argument of [
        `--require=${input}`,
        `--config="${input}"`,
        `/config:${input}`,
        `@${input}`,
      ]) {
        await expect(runCommand({
          executable,
          argv: [argument],
        }, {
          trustedOnly: true,
        })).rejects.toMatchObject({ code: 'UNSAFE_COMMAND' })
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('rejects a ProgramData prefix and directory junction before ACL registration', async () => {
    const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-realpath-exec-'))
    const managedRoot = path.join(programData, 'XingMangAI')
    const realDirectory = path.join(managedRoot, 'real')
    const aliasDirectory = path.join(managedRoot, 'alias')
    fs.mkdirSync(realDirectory, { recursive: true })
    const realExecutable = path.join(realDirectory, 'node.exe')
    try {
      try {
        fs.linkSync(process.execPath, realExecutable)
      } catch {
        fs.copyFileSync(process.execPath, realExecutable)
      }
      fs.symlinkSync(realDirectory, aliasDirectory, 'junction')
      const machinePaths = { ...testMachinePaths, programData }
      await expect(runCommand({
        executable: path.join(aliasDirectory, 'node.exe'),
        argv: ['--version'],
      }, {
        trustedOnly: true,
        machinePaths,
      })).rejects.toMatchObject({ code: 'UNSAFE_COMMAND' })
    } finally {
      fs.rmSync(programData, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('rejects WindowsApps aliases and arbitrary-drive portable tools', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\tester',
      PATH: 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps',
    }
    const trusted = trustedCommandEnvironment(env, testMachinePaths).PATH ?? ''
    expect(trusted).not.toContain('WindowsApps')
    expect(isUserWritablePath(
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe',
      env,
      testMachinePaths,
    )).toBe(true)
    expect(isTrustedHighIntegrityExecutable('E:\\portable\\node.exe', {}, 'win32', testMachinePaths)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('prefers the trusted npm.cmd shim over the POSIX npm shim', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-command-runner-'))
    try {
      fs.writeFileSync(path.join(directory, 'npm'), '#!/bin/sh\n', 'utf8')
      fs.writeFileSync(path.join(directory, 'npm.cmd'), '@echo off\r\n', 'utf8')
      const executable = await findExecutable('npm', {
        env: { PATH: directory },
        windowsPackageManagers: ['npm'],
      })
      expect(executable).toBe(path.join(directory, 'npm.cmd'))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
