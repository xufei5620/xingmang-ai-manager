import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliExitHintLines, macosFolderAccessHintLines } from './cli-exit-hint'
import {
  buildMacosClosedProxyGuard,
  buildMacosTerminalScript,
  cleanupStaleTerminalDirectories,
  launchMacosTerminal,
  quotePosixArgument,
} from './macos-platform'
import { parseLoopbackProxyTarget, staleProxyVariableNames } from './stale-proxy-environment'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const servers: net.Server[] = []

// 真跑那几行 zsh 的用例：Mac 上总有 /bin/zsh；Linux 上装了 zsh 也跑（探测换成假的 nc，见下）。
const zshAvailable = process.platform !== 'win32' && fs.existsSync('/bin/zsh')

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function listeningPort(): Promise<number> {
  const server = net.createServer((socket) => socket.destroy())
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

/**
 * Stands in for /usr/bin/nc where it is not the macOS one: Linux nc has no -G.
 * It records every probe and answers "open" only for the ports listed in
 * FAKE_NC_OPEN (or for every port when that says `all`). Like nc without -v it
 * fails silently; with FAKE_NC_BROKEN set it complains the way nc does about an
 * option it does not know.
 */
function writeFakePortProbe(directory: string): string {
  const file = path.join(directory, 'fake-nc')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$FAKE_NC_LOG"',
    'if [ -n "${FAKE_NC_BROKEN:-}" ]; then echo "nc: illegal option -- G" >&2; exit 1; fi',
    'for port in $FAKE_NC_OPEN; do',
    '  if [ "$port" = all ] || [ "$port" = "$6" ]; then exit 0; fi',
    'done',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o700 })
  return file
}

interface GuardRun {
  /** What a program started after the guard sees. */
  env: NodeJS.ProcessEnv
  /** The probe's arguments, one line per call. */
  probes: string[]
  /** Everything that would have shown up in the user's Terminal window as an error. */
  stderr: string
}

let guardRuns = 0

/**
 * Runs the guard the way the launcher does (`zsh -f` under `set -eu`, in the
 * UTF-8 locale Terminal sets), with the proxies as a login shell that read
 * ~/.zshrc would have passed them down. The script exits 7 when the guard
 * leaves errexit or nounset switched off.
 */
async function runClosedProxyGuard(
  directory: string,
  probe: string,
  proxies: Record<string, string>,
  openPorts: string,
  extraEnv: Record<string, string> = {},
): Promise<GuardRun> {
  guardRuns += 1
  const script = path.join(directory, `guard-${guardRuns}.zsh`)
  const log = path.join(directory, `probes-${guardRuns}.log`)
  fs.writeFileSync(script, [
    '#!/bin/zsh -f',
    'set -eu',
    ...buildMacosClosedProxyGuard(probe),
    '[[ -o errexit && -o nounset ]] || exit 7',
    `${quotePosixArgument(process.execPath)} -e 'process.stdout.write(JSON.stringify(process.env))'`,
    '',
  ].join('\n'), { mode: 0o700 })
  const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-f', script], {
    env: {
      HOME: directory,
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      FAKE_NC_LOG: log,
      FAKE_NC_OPEN: openPorts,
      ...extraEnv,
      ...proxies,
    },
  })
  return {
    env: JSON.parse(stdout) as NodeJS.ProcessEnv,
    probes: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    stderr,
  }
}

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
    expect(script.indexOf('export PATH=')).toBeLessThan(script.indexOf("trap ':' INT"))
    for (const key of ['PWD', 'OLDPWD', 'SHLVL', '_']) {
      expect(script).not.toContain(`export ${key}=`)
    }
    expect(fs.existsSync(launcher)).toBe(false)
  })

  it('carries the system certificate trust switch into the terminal', () => {
    const script = buildMacosTerminalScript({
      executable: '/usr/local/bin/claude',
      argv: [],
      workspace: '/workspace',
      launcherPath: '/tmp/launcher',
      env: { HOME: '/Users/tester', PATH: '/usr/bin', NODE_USE_SYSTEM_CA: '1', NODE_OPTIONS: '--require=/tmp/x.js' },
    })
    expect(script).toContain("export NODE_USE_SYSTEM_CA='1'")
    // 放行的只是这一项，名单外的仍然不导出。
    expect(script).not.toContain('export NODE_OPTIONS=')
  })

  it('stays in the launcher after the CLI exits to tell the user what to do next', () => {
    const script = buildMacosTerminalScript({
      executable: '/usr/local/bin/codex',
      argv: ['resume', '--last'],
      workspace: '/workspace',
      launcherPath: '/tmp/launcher',
      env: { HOME: '/tmp/home', PATH: '/usr/bin' },
    })

    expect(script).not.toMatch(/^exec\b/m)
    expect(script).toContain("'/usr/local/bin/codex' 'resume' '--last' || cli_exit_code=$?")
    const exitCheck = script.indexOf('if [ "$cli_exit_code" -eq 0 ]; then')
    const otherwise = script.indexOf('\nelse\n')
    expect(exitCheck).toBeGreaterThan(script.indexOf('|| cli_exit_code=$?'))
    for (const line of cliExitHintLines.normal) {
      const index = script.indexOf(`print -r -- '${line}'`)
      expect(index).toBeGreaterThan(exitCheck)
      expect(index).toBeLessThan(otherwise)
    }
    for (const line of cliExitHintLines.unexpected) {
      expect(script.indexOf(`print -r -- '${line}'`)).toBeGreaterThan(otherwise)
    }
  })

  it.runIf(process.platform === 'darwin')('prints the normal hint on a clean exit and the cautious one otherwise', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-exit-hint-'))
    temporaryDirectories.push(directory)
    for (const [executable, expected, absent] of [
      ['/usr/bin/true', cliExitHintLines.normal, cliExitHintLines.unexpected],
      ['/usr/bin/false', cliExitHintLines.unexpected, cliExitHintLines.normal],
    ] as const) {
      // The launcher removes itself and its (then empty) directory, so each
      // run gets its own launcher directory apart from the workspace.
      const launcher = path.join(fs.mkdtempSync(path.join(directory, 'launcher-')), 'launcher.zsh')
      fs.writeFileSync(launcher, buildMacosTerminalScript({
        executable,
        argv: [],
        workspace: directory,
        launcherPath: launcher,
        env: { HOME: directory, PATH: '/usr/bin' },
      }), { mode: 0o700 })

      const output = execFileSync('/bin/zsh', ['-f', launcher], { encoding: 'utf8' })
      for (const line of expected) expect(output).toContain(line)
      for (const line of absent) expect(output).not.toContain(line)
    }
  })

  it('checks the project folder can be entered and read before starting the CLI', () => {
    const script = buildMacosTerminalScript({
      executable: '/usr/local/bin/claude',
      argv: [],
      workspace: '/Users/alex/Documents/project',
      launcherPath: '/tmp/launcher',
      env: { HOME: '/tmp/home', PATH: '/usr/bin' },
    })

    const enter = script.indexOf("if ! cd -- '/Users/alex/Documents/project' 2>/dev/null; then")
    const read = script.indexOf('if ! /bin/ls -A -- . >/dev/null 2>&1; then')
    const cli = script.indexOf("'/usr/local/bin/claude' || cli_exit_code=$?")
    expect(enter).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(enter)
    expect(cli).toBeGreaterThan(read)
    for (const line of macosFolderAccessHintLines.unreachable) {
      const index = script.indexOf(`print -r -- '${line}'`)
      expect(index).toBeGreaterThan(enter)
      expect(index).toBeLessThan(read)
    }
    for (const line of macosFolderAccessHintLines.unreadable) {
      const index = script.indexOf(`print -r -- '${line}'`)
      expect(index).toBeGreaterThan(read)
      expect(index).toBeLessThan(cli)
    }
    expect(script.slice(enter, cli).match(/^ {2}exit 1$/gm)).toHaveLength(2)
  })

  it.runIf(process.platform === 'darwin' && process.getuid?.() !== 0)('explains an unreachable or unreadable folder in Chinese and does not start the CLI', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-folder-access-'))
    temporaryDirectories.push(directory)
    const marker = path.join(directory, 'cli-started')
    const fakeCli = path.join(directory, 'fake-cli')
    fs.writeFileSync(fakeCli, `#!/bin/sh\n/usr/bin/touch ${quotePosixArgument(marker)}\n`, { mode: 0o700 })
    // 能进不能读：受保护文件夹被拒时大致是这个样子（推测）。
    const unreadable = path.join(directory, 'unreadable')
    fs.mkdirSync(unreadable, { mode: 0o300 })
    try {
      for (const [workspace, expected, absent] of [
        [path.join(directory, 'missing'), macosFolderAccessHintLines.unreachable, macosFolderAccessHintLines.unreadable],
        [unreadable, macosFolderAccessHintLines.unreadable, macosFolderAccessHintLines.unreachable],
      ] as const) {
        const launcher = path.join(fs.mkdtempSync(path.join(directory, 'launcher-')), 'launcher.zsh')
        fs.writeFileSync(launcher, buildMacosTerminalScript({
          executable: fakeCli,
          argv: [],
          workspace,
          launcherPath: launcher,
          env: { HOME: directory, PATH: '/usr/bin' },
        }), { mode: 0o700 })

        let output = ''
        try {
          execFileSync('/bin/zsh', ['-f', launcher], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          const failure = error as { status?: number, stdout?: string, stderr?: string }
          expect(failure.status).toBe(1)
          expect(failure.stderr ?? '').toBe('')
          output = failure.stdout ?? ''
        }
        for (const line of expected) expect(output).toContain(line)
        for (const line of absent) expect(output).not.toContain(line)
        expect(fs.existsSync(marker)).toBe(false)
      }
    } finally {
      fs.chmodSync(unreadable, 0o700)
    }
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
      // Registered the moment the directory exists: anything after this point can
      // throw, and afterEach would otherwise never learn about the mkdtemp tree.
      temporaryDirectories.push(path.dirname(launcherPath), `${path.dirname(launcherPath)}-original`)
    }, (task) => {
      cleanup = task
    })

    const launcherDirectory = path.dirname(launcherPath)
    const originalDirectory = `${launcherDirectory}-original`
    fs.renameSync(launcherDirectory, originalDirectory)
    fs.mkdirSync(launcherDirectory, { mode: 0o700 })
    fs.linkSync(path.join(originalDirectory, 'launch.zsh'), launcherPath)

    await cleanup!()

    expect(fs.existsSync(launcherPath)).toBe(true)
  })
  it('collects launcher directories whose creating process is gone', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-terminal-base-'))
    temporaryDirectories.push(base)
    const abandoned = path.join(base, 'xingmang-terminal-424242-abandoned')
    const owned = path.join(base, 'xingmang-terminal-424243-owned')
    const unrelated = path.join(base, 'some-other-directory')
    for (const directory of [abandoned, owned, unrelated]) fs.mkdirSync(directory, { mode: 0o700 })
    fs.writeFileSync(path.join(abandoned, 'launch.zsh'), 'stale', { mode: 0o700 })

    await cleanupStaleTerminalDirectories(base, (processId) => processId === 424243)

    // Gone: its owner is dead, so the five-minute cleanup will never run.
    expect(fs.existsSync(abandoned)).toBe(false)
    // Kept: the owner is still running and may be waiting out that window.
    expect(fs.existsSync(owned)).toBe(true)
    // Kept: not ours to touch.
    expect(fs.existsSync(unrelated)).toBe(true)
  })

  it('leaves no directory behind when the launcher write fails', async () => {
    let created = ''
    const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises)
    vi.spyOn(fs.promises, 'mkdtemp').mockImplementation((async (prefix: string) => {
      created = await originalMkdtemp(prefix)
      return created
    }) as typeof fs.promises.mkdtemp)
    const originalChmod = fs.promises.chmod.bind(fs.promises)
    vi.spyOn(fs.promises, 'chmod').mockImplementation((async (target: string, mode: number) => {
      // Fail after the partial file exists but before it is renamed into place.
      if (String(target).endsWith('.tmp')) throw new Error('chmod failed')
      return originalChmod(target, mode)
    }) as typeof fs.promises.chmod)

    await expect(launchMacosTerminal({
      executable: '/usr/bin/true',
      argv: [],
      workspace: os.tmpdir(),
      env: { HOME: os.tmpdir(), PATH: '/usr/bin' },
    }, async () => undefined, () => undefined)).rejects.toThrow('chmod failed')

    expect(created).not.toBe('')
    expect(fs.existsSync(created)).toBe(false)
  })

  it('leaves no executable launcher behind when identity capture fails', async () => {
    let created = ''
    const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises)
    vi.spyOn(fs.promises, 'mkdtemp').mockImplementation((async (prefix: string) => {
      created = await originalMkdtemp(prefix)
      return created
    }) as typeof fs.promises.mkdtemp)
    const originalLstat = fs.promises.lstat.bind(fs.promises)
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: string, options?: object) => {
      // The launcher is already written and 0700 at this point.
      if (String(target).endsWith('launch.zsh')) throw new Error('lstat failed')
      return originalLstat(target, options as never)
    }) as typeof fs.promises.lstat)

    await expect(launchMacosTerminal({
      executable: '/usr/bin/true',
      argv: [],
      workspace: os.tmpdir(),
      env: { HOME: os.tmpdir(), PATH: '/usr/bin' },
    }, async () => undefined, () => undefined)).rejects.toThrow('lstat failed')

    expect(created).not.toBe('')
    expect(fs.existsSync(created)).toBe(false)
  })
})

describe('macOS terminal launcher with proxies left by the login shell', () => {
  function probeLine(host: string, port: number): string {
    return `-z -n -G 1 ${host} ${port}`
  }

  it('checks the proxies after the exports and before the CLI starts', () => {
    const script = buildMacosTerminalScript({
      executable: '/usr/local/bin/claude',
      argv: [],
      workspace: '/workspace',
      launcherPath: '/tmp/launcher',
      env: { HOME: '/tmp/home', PATH: '/usr/bin' },
    })
    const guard = buildMacosClosedProxyGuard().join('\n')
    const start = script.indexOf(guard)
    expect(start).toBeGreaterThan(script.indexOf('export PATH='))
    expect(start + guard.length).toBeLessThan(script.indexOf("trap ':' INT"))
    // The SIP-protected system nc by absolute path: PATH is never consulted.
    expect(guard).toContain("if failure=$('/usr/bin/nc' -z -n -G 1 $address $port 2>&1 </dev/null >/dev/null); then")
    // Nothing the guard itself might say reaches the user's Terminal window.
    expect(guard.endsWith('} 2>/dev/null')).toBe(true)
  })

  it('looks at the same proxy names as Windows and Linux, in both spellings', () => {
    const loop = buildMacosClosedProxyGuard().find((line) => line.trimStart().startsWith('for name in '))
    expect(loop?.trim()).toBe(`for name in ${staleProxyVariableNames.flatMap((name) => [name, name.toLowerCase()]).join(' ')}; do`)
  })

  it.runIf(zshAvailable)('drops a proxy only when its loopback port does not answer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-proxy-guard-'))
    temporaryDirectories.push(directory)

    const { env, probes, stderr } = await runClosedProxyGuard(directory, writeFakePortProbe(directory), {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      http_proxy: 'http://user:secret@LOCALHOST:1080/',
      ALL_PROXY: 'socks5://proxy.corp.example:1080',
      all_proxy: 'not a proxy',
    }, '1080')

    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.https_proxy).toBeUndefined()
    expect(env.http_proxy).toBe('http://user:secret@LOCALHOST:1080/')
    expect(env.ALL_PROXY).toBe('socks5://proxy.corp.example:1080')
    expect(env.all_proxy).toBe('not a proxy')
    // One probe per port; a remote or unreadable value is never probed.
    expect(probes).toEqual([probeLine('127.0.0.1', 1080), probeLine('127.0.0.1', 7890)])
    expect(stderr).toBe('')
  })

  it.runIf(zshAvailable)('tries both loopback addresses before calling localhost closed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-proxy-guard-'))
    temporaryDirectories.push(directory)

    const { env, probes, stderr } = await runClosedProxyGuard(directory, writeFakePortProbe(directory), {
      HTTP_PROXY: 'http://[::1]:7892',
      ALL_PROXY: 'socks5://localhost:7891',
    }, '')

    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.ALL_PROXY).toBeUndefined()
    expect(probes).toEqual([probeLine('::1', 7892), probeLine('127.0.0.1', 7891), probeLine('::1', 7891)])
    expect(stderr).toBe('')
  })

  it.runIf(zshAvailable)('keeps the proxy when the probe itself reports an error rather than a closed port', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-proxy-guard-'))
    temporaryDirectories.push(directory)

    const { env, probes, stderr } = await runClosedProxyGuard(directory, writeFakePortProbe(directory), {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://localhost:7891',
    }, '', { FAKE_NC_BROKEN: '1' })

    // An nc that rejects its options would otherwise strip every working proxy.
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.ALL_PROXY).toBe('socks5://localhost:7891')
    expect(probes).toEqual([probeLine('127.0.0.1', 7890), probeLine('127.0.0.1', 7891), probeLine('::1', 7891)])
    expect(stderr).toBe('')
  })

  it.runIf(zshAvailable)('leaves every proxy alone when there is nothing to probe with', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-proxy-guard-'))
    temporaryDirectories.push(directory)

    const { env, probes, stderr } = await runClosedProxyGuard(directory, path.join(directory, 'missing-nc'), {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    }, '')

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(probes).toEqual([])
    expect(stderr).toBe('')
  })

  it.runIf(zshAvailable)('recognizes the same loopback targets as parseLoopbackProxyTarget', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-proxy-guard-'))
    temporaryDirectories.push(directory)
    const probe = writeFakePortProbe(directory)
    // 表里不放 http 的 :80、https 的 :443：那边的 URL 解析把默认端口当成没写、照旧带上，
    // 这里写出来的端口照样探。那两个端口上没人开代理，不为它多写几行。也不放 127.1、
    // [0:0:0:0:0:0:0:1] 这类简写：那边还原成本机地址去探，这里不认、照旧带上。
    const values = [
      'http://127.0.0.1:7890',
      '127.0.0.1:7890',
      ' socks5://LOCALHOST:1080 ',
      'http://user:secret@127.0.0.2:8080/',
      'http://[::1]:7890',
      'socks5h://localhost:7891',
      'HTTP://Localhost:07890/path?x=1#y',
      'http://a@b@127.0.0.1:7890',
      'http://127.0.0.1:7890@proxy.corp.example:8080',
      'http://proxy.corp.example:8080',
      'http://10.0.0.5:7890',
      'http://[::2]:7890',
      'http://localhost.:7890',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:7890abc',
      'http://127.0.0.1:７８９０',
      'http://代理.example:7890',
      'not a url at all',
    ]

    for (const value of values) {
      const target = parseLoopbackProxyTarget(value)
      const { probes, stderr } = await runClosedProxyGuard(directory, probe, { HTTPS_PROXY: value }, 'all')
      expect({ value, probes, stderr }).toEqual({
        value,
        probes: target ? [probeLine(target.host === 'localhost' ? '127.0.0.1' : target.host, target.port)] : [],
        stderr: '',
      })
    }
  })

  it.runIf(process.platform === 'darwin')('tells an open loopback proxy from a closed one with the macOS nc', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-proxy-launch-'))
    temporaryDirectories.push(directory)
    const open = await listeningPort()
    const closed = await closedPort()
    const output = path.join(directory, 'env.json')
    const launcher = path.join(fs.mkdtempSync(path.join(directory, 'launcher-')), 'launcher.zsh')
    fs.writeFileSync(launcher, buildMacosTerminalScript({
      executable: process.execPath,
      argv: ['-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))', output],
      workspace: directory,
      launcherPath: launcher,
      env: { HOME: directory, PATH: '/usr/bin:/bin' },
    }), { mode: 0o700 })

    // What Terminal's login shell hands down after reading ~/.zshrc.
    const { stderr } = await execFileAsync('/bin/zsh', ['-f', launcher], {
      env: {
        HOME: directory,
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        https_proxy: `http://127.0.0.1:${closed}`,
        all_proxy: `socks5://localhost:${closed}`,
        HTTPS_PROXY: `http://localhost:${open}`,
        HTTP_PROXY: 'http://proxy.corp.example:8080',
      },
    })

    const env = JSON.parse(fs.readFileSync(output, 'utf8')) as NodeJS.ProcessEnv
    expect(env.https_proxy).toBeUndefined()
    expect(env.all_proxy).toBeUndefined()
    expect(env.HTTPS_PROXY).toBe(`http://localhost:${open}`)
    expect(env.HTTP_PROXY).toBe('http://proxy.corp.example:8080')
    expect(stderr).toBe('')
  })
})
