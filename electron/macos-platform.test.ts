import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildMacosTerminalScript,
  launchMacosTerminal,
  quotePosixArgument,
} from './macos-platform'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('macOS terminal launcher', () => {
  it('quotes POSIX argument metacharacters as inert data', () => {
    expect(quotePosixArgument('')).toBe("''")
    expect(quotePosixArgument("space ' $HOME $(touch /tmp/nope)\n--value"))
      .toBe("'space '\\'' $HOME $(touch /tmp/nope)\n--value'")
  })

  it.runIf(process.platform === 'darwin')('runs the resolved executable with literal argv and removes its launcher', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-script-'))
    temporaryDirectories.push(directory)
    const workspace = path.join(directory, "workspace $() ' space")
    const launcher = path.join(directory, 'launcher.zsh')
    const output = path.join(directory, 'result.json')
    const argv = ['space value', "single'quote", '$HOME', '$(touch should-not-run)', '\n--leading-dash']
    const environment = {
      HOME: path.join(directory, "home '$()"),
      CODEX_HOME: path.join(directory, 'codex $HOME $(touch should-not-run)'),
      PATH: `/custom/bin${path.delimiter}/usr/bin`,
      PWD: '/',
      OLDPWD: '/stale-old-workspace',
      SHLVL: '999',
      _: '/stale/manager-command',
    }
    fs.mkdirSync(workspace)
    const script = buildMacosTerminalScript({
      executable: process.execPath,
      argv: ['-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH, PWD: process.env.PWD } }))', output, ...argv],
      workspace,
      launcherPath: launcher,
      env: environment,
    })
    fs.writeFileSync(launcher, script, { mode: 0o700 })

    execFileSync('/bin/zsh', ['-f', launcher])

    const result = JSON.parse(fs.readFileSync(output, 'utf8')) as {
      cwd: string
      argv: string[]
      env: Record<string, string>
    }
    expect(result).toEqual({
      cwd: fs.realpathSync(workspace),
      argv,
      env: {
        HOME: environment.HOME,
        CODEX_HOME: environment.CODEX_HOME,
        PATH: environment.PATH,
        PWD: workspace,
      },
    })
    expect(fs.realpathSync(result.env.PWD)).toBe(result.cwd)
    expect(script.indexOf('rm -f --')).toBeLessThan(script.indexOf('cd --'))
    expect(script.indexOf('cd --')).toBeLessThan(script.indexOf('export CODEX_HOME='))
    expect(script.indexOf('export CODEX_HOME=')).toBeLessThan(script.indexOf('export HOME='))
    expect(script.indexOf('export HOME=')).toBeLessThan(script.indexOf('export PATH='))
    expect(script.indexOf('export PATH=')).toBeLessThan(script.indexOf('exec --'))
    for (const key of ['PWD', 'OLDPWD', 'SHLVL', '_']) {
      expect(script).not.toContain(`export ${key}=`)
    }
    expect(fs.existsSync(launcher)).toBe(false)
  })

  it('rejects invalid environment keys and NUL values', () => {
    const base = {
      executable: '/usr/bin/true',
      argv: [],
      workspace: '/workspace',
      launcherPath: '/tmp/launcher',
    }
    expect(() => buildMacosTerminalScript({
      ...base,
      env: { 'CODEX-HOME': '/tmp/codex' },
    })).toThrow('environment key')
    expect(() => buildMacosTerminalScript({
      ...base,
      env: { CODEX_HOME: '/tmp/codex\0other' },
    })).toThrow('environment value')
    expect(() => buildMacosTerminalScript({
      ...base,
      env: { HOME: '/tmp/home' },
    })).toThrow('PATH')
  })

  it('rejects non-absolute paths in terminal scripts', () => {
    expect(() => buildMacosTerminalScript({
      executable: 'codex',
      argv: [],
      workspace: '/workspace',
      launcherPath: '/tmp/launcher',
      env: { HOME: '/tmp/home', PATH: '/usr/bin' },
    })).toThrow('absolute')
  })

  it.runIf(process.platform === 'darwin')('removes its launcher before a missing workspace makes execution fail', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-missing-workspace-'))
    temporaryDirectories.push(directory)
    const launcher = path.join(directory, 'launcher.zsh')
    fs.writeFileSync(launcher, buildMacosTerminalScript({
      executable: '/usr/bin/true',
      argv: [],
      workspace: path.join(directory, 'missing-workspace'),
      launcherPath: launcher,
      env: { HOME: directory, PATH: '/usr/bin' },
    }), { mode: 0o700 })

    expect(() => execFileSync('/bin/zsh', ['-f', launcher], { stdio: 'pipe' })).toThrow()
    expect(fs.existsSync(launcher)).toBe(false)
  })

  it('removes a launcher when opening Terminal fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-launcher-'))
    temporaryDirectories.push(directory)
    const failure = new Error('open failed')
    const run = vi.fn().mockRejectedValue(failure)

    await expect(launchMacosTerminal({
      executable: '/usr/bin/true',
      argv: [],
      workspace: directory,
      env: { HOME: directory, PATH: '/usr/bin' },
    }, run)).rejects.toBe(failure)

    const launcherPath = run.mock.calls[0]?.[0].argv[2]
    expect(run).toHaveBeenCalledWith({
      executable: '/usr/bin/open',
      argv: ['-a', 'Terminal', launcherPath],
    }, expect.any(Object))
    expect(fs.existsSync(launcherPath)).toBe(false)
  })

  it('writes only the explicit CLI environment and leaves arbitrary secrets off disk', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-environment-'))
    temporaryDirectories.push(directory)
    const secret = 'api-token-that-must-not-reach-launcher'
    let launcherContent = ''

    await launchMacosTerminal({
      executable: '/usr/bin/true',
      argv: [],
      workspace: directory,
      env: {
        HOME: directory,
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        CODEX_HOME: path.join(directory, '.codex'),
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'zh_CN.UTF-8',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3',
        CLICOLOR: '1',
        CLICOLOR_FORCE: '1',
        API_TOKEN: secret,
        XINGMANG_ENV_SENTINEL: 'unknown-values-must-not-be-persisted',
      },
    }, async (spec) => {
      temporaryDirectories.push(path.dirname(spec.argv[2]))
      launcherContent = fs.readFileSync(spec.argv[2], 'utf8')
    }, () => undefined)

    expect(launcherContent).toContain(`export HOME='${directory}'`)
    expect(launcherContent).toContain("export PATH='/opt/homebrew/bin:/usr/bin:/bin'")
    expect(launcherContent).toContain(`export CODEX_HOME='${path.join(directory, '.codex')}'`)
    expect(launcherContent).toContain("export LANG='en_US.UTF-8'")
    expect(launcherContent).toContain("export LC_CTYPE='zh_CN.UTF-8'")
    expect(launcherContent).toContain("export TERM='xterm-256color'")
    expect(launcherContent).toContain("export COLORTERM='truecolor'")
    expect(launcherContent).toContain("export FORCE_COLOR='3'")
    expect(launcherContent).toContain("export CLICOLOR='1'")
    expect(launcherContent).toContain("export CLICOLOR_FORCE='1'")
    expect(launcherContent).not.toContain(secret)
    expect(launcherContent).not.toContain('API_TOKEN')
    expect(launcherContent).not.toContain('XINGMANG_ENV_SENTINEL')
  })

  it('schedules bounded cleanup when open succeeds without executing the launcher', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-scheduled-cleanup-'))
    temporaryDirectories.push(directory)
    let launcherPath = ''
    let cleanup: (() => Promise<void>) | undefined
    let cleanupDelayMs = 0

    await launchMacosTerminal({
      executable: '/usr/bin/true',
      argv: [],
      workspace: directory,
      env: { HOME: directory, PATH: '/usr/bin' },
    }, async (spec) => {
      launcherPath = spec.argv[2]
      temporaryDirectories.push(path.dirname(launcherPath))
    }, (task, delayMs) => {
      cleanup = task
      cleanupDelayMs = delayMs
    })

    expect(fs.existsSync(launcherPath)).toBe(true)
    expect(cleanupDelayMs).toBeGreaterThan(0)
    expect(cleanupDelayMs).toBeLessThanOrEqual(5 * 60_000)
    expect(cleanup).toBeTypeOf('function')

    await cleanup!()

    expect(fs.existsSync(launcherPath)).toBe(false)
    expect(fs.existsSync(path.dirname(launcherPath))).toBe(false)
  })

  // Runs on every platform on purpose. The property must not depend on whether the
  // filesystem recycles a freed inode number: ext4 and tmpfs hand it straight back,
  // and identity alone would then mistake the replacement for our own launcher.
  it('does not delete a replacement at the scheduled launcher path', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-replaced-launcher-'))
    temporaryDirectories.push(directory)
    let launcherPath = ''
    let cleanup: (() => Promise<void>) | undefined

    await launchMacosTerminal({
      executable: '/usr/bin/true',
      argv: [],
      workspace: directory,
      env: { HOME: directory, PATH: '/usr/bin' },
    }, async (spec) => {
      launcherPath = spec.argv[2]
      temporaryDirectories.push(path.dirname(launcherPath))
    }, (task) => {
      cleanup = task
    })

    fs.unlinkSync(launcherPath)
    fs.writeFileSync(launcherPath, 'replacement', { mode: 0o700 })

    await cleanup!()

    expect(fs.readFileSync(launcherPath, 'utf8')).toBe('replacement')
  })

  it('does not delete a launcher hard-linked through a replacement directory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-replaced-directory-'))
    temporaryDirectories.push(directory)
    let launcherPath = ''
    let cleanup: (() => Promise<void>) | undefined

    await launchMacosTerminal({
      executable: '/usr/bin/true',
      argv: [],
      workspace: directory,
      env: { HOME: directory, PATH: '/usr/bin' },
    }, async (spec) => {
      launcherPath = spec.argv[2]
    }, (task) => {
      cleanup = task
    })

    const launcherDirectory = path.dirname(launcherPath)
    const originalDirectory = `${launcherDirectory}-original`
    temporaryDirectories.push(launcherDirectory, originalDirectory)
    fs.renameSync(launcherDirectory, originalDirectory)
    fs.mkdirSync(launcherDirectory, { mode: 0o700 })
    fs.linkSync(path.join(originalDirectory, 'launch.zsh'), launcherPath)

    await cleanup!()

    expect(fs.existsSync(launcherPath)).toBe(true)
  })
})
