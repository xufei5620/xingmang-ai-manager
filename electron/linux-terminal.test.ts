import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliCloseWindowPrompt, cliExitHintLines, linuxFolderAccessHintLines } from './cli-exit-hint'
import {
  buildLinuxTerminalArgv,
  buildLinuxTerminalScript,
  findLinuxTerminals,
  launchLinuxTerminal,
  LinuxTerminalLaunchError,
  linuxTerminalFailureMessages,
  linuxTerminalSearchDirectories,
  linuxTerminalTable,
  resolveLinuxLauncherBaseDirectories,
  type LinuxTerminalCandidate,
  type LinuxTerminalProcess,
  type LinuxTerminalSpawner,
} from './linux-terminal'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const launcher = '/run/user/1000/xingmang-terminal-42-AbC123/launch.sh'

function scriptPlan(overrides: Partial<Parameters<typeof buildLinuxTerminalScript>[0]> = {}): Parameters<typeof buildLinuxTerminalScript>[0] {
  return {
    executable: '/home/a/.local/share/XingMangAI/Cli/npm/bin/claude',
    argv: [],
    workspace: '/home/a/project',
    launcherPath: launcher,
    title: 'Claude Code · 星芒AI',
    env: { HOME: '/home/a', PATH: '/usr/bin:/bin' },
    ...overrides,
  }
}

describe('Linux terminal arguments', () => {
  it('hands every terminal only /bin/sh and the launcher, never one bare argument after -e', () => {
    for (const definition of linuxTerminalTable) {
      const argv = buildLinuxTerminalArgv(definition.id, launcher)
      const joined = argv.at(-1) === `/bin/sh ${launcher}`
      if (joined) {
        expect(argv.slice(0, -1).every((argument) => argument.startsWith('-'))).toBe(true)
      } else {
        expect(argv.slice(-2)).toEqual(['/bin/sh', launcher])
      }
      expect(argv.join(' ')).not.toMatch(/claude|project|星芒/)
    }
  })

  it('uses the Debian Policy -e form for the generic x-terminal-emulator', () => {
    expect(buildLinuxTerminalArgv('x-terminal-emulator', launcher)).toEqual(['-e', '/bin/sh', launcher])
    expect(buildLinuxTerminalArgv('gnome-terminal', launcher)).toEqual(['--', '/bin/sh', launcher])
    expect(buildLinuxTerminalArgv('deepin-terminal', launcher)).toEqual(['-e', '/bin/sh', launcher])
    expect(buildLinuxTerminalArgv('mate-terminal', launcher)).toEqual(['-x', '/bin/sh', launcher])
    expect(buildLinuxTerminalArgv('lxterminal', launcher)).toEqual(['-e', `/bin/sh ${launcher}`])
  })

  it('refuses a launcher path a single-string terminal would split or a shell would read', () => {
    for (const unsafe of ['/tmp/with space/launch.sh', "/tmp/quote'/launch.sh", '/tmp/$(x)/launch.sh', 'relative/launch.sh', '/tmp/../etc/launch.sh']) {
      expect(() => buildLinuxTerminalArgv('xterm', unsafe)).toThrow(TypeError)
    }
  })
})

describe('Linux terminal discovery', () => {
  function discover(env: NodeJS.ProcessEnv, installed: readonly string[], links: Record<string, string> = {}): LinuxTerminalCandidate[] {
    return findLinuxTerminals(env, {
      isExecutableFile: (filePath) => installed.includes(filePath),
      realpath: (filePath) => links[filePath] ?? filePath,
    })
  }

  it('searches only absolute PATH entries plus the standard system directories', () => {
    expect(linuxTerminalSearchDirectories({ PATH: '.:node_modules/.bin::/opt/x/bin:/usr/bin/' })).toEqual([
      '/opt/x/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/bin',
    ])
  })

  it('never returns a bare name, so a project folder cannot supply its own terminal', () => {
    const checked: string[] = []
    const found = findLinuxTerminals({ PATH: '.:bin' }, {
      isExecutableFile: (filePath) => {
        checked.push(filePath)
        return filePath === '/usr/bin/xterm'
      },
      realpath: () => null,
    })
    expect(found).toEqual([{ id: 'xterm', label: 'XTerm', executable: '/usr/bin/xterm' }])
    expect(checked.every((filePath) => path.posix.isAbsolute(filePath))).toBe(true)
  })

  it('puts the running desktop’s own terminal first', () => {
    const installed = ['/usr/bin/gnome-terminal', '/usr/bin/deepin-terminal', '/usr/bin/mate-terminal', '/usr/bin/konsole']
    expect(discover({ PATH: '/usr/bin', XDG_CURRENT_DESKTOP: 'Deepin' }, installed)[0]?.id).toBe('deepin-terminal')
    expect(discover({ PATH: '/usr/bin', XDG_CURRENT_DESKTOP: 'UKUI' }, installed)[0]?.id).toBe('mate-terminal')
    expect(discover({ PATH: '/usr/bin', XDG_CURRENT_DESKTOP: 'KDE' }, installed)[0]?.id).toBe('konsole')
    expect(discover({ PATH: '/usr/bin', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, installed)[0]?.id).toBe('gnome-terminal')
  })

  it('follows the system default terminal through /etc/alternatives and keeps the generic form as the last resort', () => {
    const found = discover(
      { PATH: '/usr/bin' },
      ['/usr/bin/x-terminal-emulator', '/usr/bin/terminator', '/usr/bin/xterm'],
      { '/usr/bin/x-terminal-emulator': '/usr/bin/terminator' },
    )
    expect(found.map((candidate) => candidate.id)).toEqual(['terminator', 'xterm', 'x-terminal-emulator'])
    expect(found.at(-1)).toEqual({ id: 'x-terminal-emulator', label: '系统默认终端', executable: '/usr/bin/x-terminal-emulator' })
  })

  it('maps a Debian wrapper back to the terminal it wraps', () => {
    const found = discover(
      { PATH: '/usr/bin' },
      ['/usr/bin/x-terminal-emulator', '/usr/bin/xterm', '/usr/bin/xfce4-terminal'],
      { '/usr/bin/x-terminal-emulator': '/usr/bin/xfce4-terminal.wrapper' },
    )
    expect(found[0]?.id).toBe('xfce4-terminal')
  })

  it('finds nothing on a machine without any terminal', () => {
    expect(discover({ PATH: '/usr/bin' }, [])).toEqual([])
  })
})

describe('Linux launcher directory', () => {
  const uid = 1000
  function facts(table: Record<string, { uid: number; mode: number; symlink?: boolean } | undefined>) {
    return (directory: string) => {
      const entry = table[directory]
      return entry ? { isDirectory: !entry.symlink, isSymbolicLink: Boolean(entry.symlink), uid: entry.uid, mode: entry.mode } : null
    }
  }

  it('prefers the private per-user runtime directory', () => {
    expect(resolveLinuxLauncherBaseDirectories(
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      facts({ '/run/user/1000': { uid, mode: 0o40700 }, '/tmp': { uid: 0, mode: 0o41777 } }),
      uid,
      '/tmp',
    )).toEqual(['/run/user/1000', '/tmp'])
  })

  it('falls back to the sticky system temp directory when the runtime directory cannot be trusted', () => {
    const base = { '/tmp': { uid: 0, mode: 0o41777 } }
    for (const runtime of [
      { '/run/user/1000': { uid, mode: 0o40755 } },
      { '/run/user/1000': { uid: 1001, mode: 0o40700 } },
      { '/run/user/1000': { uid, mode: 0o40700, symlink: true } },
    ]) {
      expect(resolveLinuxLauncherBaseDirectories({ XDG_RUNTIME_DIR: '/run/user/1000' }, facts({ ...base, ...runtime }), uid, '/tmp')).toEqual(['/tmp'])
    }
    expect(resolveLinuxLauncherBaseDirectories({ XDG_RUNTIME_DIR: '/run/user/my dir' }, facts(base), uid, '/tmp')).toEqual(['/tmp'])
    expect(resolveLinuxLauncherBaseDirectories({}, facts(base), uid, '/tmp')).toEqual(['/tmp'])
  })

  it('accepts a private TMPDIR of the user’s own and refuses a shared one without the sticky bit', () => {
    expect(resolveLinuxLauncherBaseDirectories({}, facts({ '/home/a/tmp': { uid, mode: 0o40700 } }), uid, '/home/a/tmp')).toEqual(['/home/a/tmp'])
    expect(resolveLinuxLauncherBaseDirectories({}, facts({ '/tmp': { uid: 0, mode: 0o40777 } }), uid, '/tmp')).toEqual([])
  })
})

describe('Linux terminal launcher script', () => {
  it('removes itself first, then checks the folder, then starts the tool with every argument quoted', () => {
    const script = buildLinuxTerminalScript(scriptPlan({ argv: ['--resume', "a'b", '$(touch x)'] }))
    const lines = script.split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1]).toBe(`rm -f -- '${launcher}'`)
    expect(script.indexOf("cd -- '/home/a/project'")).toBeLessThan(script.indexOf('/bin/claude'))
    expect(script).toContain(`'/home/a/.local/share/XingMangAI/Cli/npm/bin/claude' '--resume' 'a'\\''b' '$(touch x)' || cli_exit_code=$?`)
    expect(script).toContain("printf '\\033]0;%s\\007' 'Claude Code · 星芒AI'")
    expect(script).toContain(cliCloseWindowPrompt)
  })

  it('writes only the listed variables, clears the account ones it does not set, and never TERM', () => {
    const script = buildLinuxTerminalScript(scriptPlan({
      env: {
        HOME: '/home/a',
        PATH: '/home/a/.local/share/XingMangAI/Runtime/node/bin:/usr/bin',
        GEMINI_API_KEY: 'sk-gemini',
        NODE_USE_SYSTEM_CA: '1',
        https_proxy: 'http://proxy.example:8080',
        LANG: 'zh_CN.UTF-8',
        TERM: 'xterm-256color',
        FORCE_COLOR: '3',
        API_TOKEN: 'must-not-reach-disk',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    }))
    expect(script).toContain("export GEMINI_API_KEY='sk-gemini'")
    expect(script).toContain("export https_proxy='http://proxy.example:8080'")
    expect(script).toContain("export LANG='zh_CN.UTF-8'")
    expect(script).toContain("export FORCE_COLOR='3'")
    expect(script).not.toContain('export TERM=')
    expect(script).not.toContain('must-not-reach-disk')
    expect(script).not.toContain('DBUS_SESSION_BUS_ADDRESS')
    const unset = script.split('\n').find((line) => line.startsWith('unset '))
    expect(unset?.split(' ').slice(1)).toEqual(expect.arrayContaining([
      'CODEX_HOME', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_API_VERSION', 'GOOGLE_GEMINI_API_KEY', 'HTTPS_PROXY', 'http_proxy', 'NO_COLOR',
    ]))
    expect(unset?.split(' ')).not.toContain('GEMINI_API_KEY')
    expect(unset?.split(' ')).not.toContain('https_proxy')
  })

  it('also clears what the plan keeps from the tool, after the folder check and before its own values', () => {
    const lines = buildLinuxTerminalScript(scriptPlan({
      env: { HOME: '/home/a', PATH: '/usr/bin', GEMINI_API_KEY: 'sk-gemini' },
      clearedEnvironmentKeys: ['ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'],
    })).split('\n')
    const unset = lines.findIndex((line) => line.startsWith('unset '))

    expect(lines[unset]?.split(' ').slice(1)).toEqual(expect.arrayContaining(['ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CODEX_HOME']))
    expect(unset).toBeGreaterThan(lines.findIndex((line) => line.startsWith('if ! cd -- ')))
    expect(unset).toBeLessThan(lines.indexOf("export GEMINI_API_KEY='sk-gemini'"))
    expect(buildLinuxTerminalScript(scriptPlan())).not.toContain('ANTHROPIC_MODEL')
  })

  it.each([
    ['A B'],
    ['X;touch /tmp/nope'],
    ['$(id)'],
    [''],
  ])('refuses %j as a variable name to clear', (name) => {
    expect(() => buildLinuxTerminalScript(scriptPlan({ clearedEnvironmentKeys: [name] }))).toThrow(TypeError)
  })

  it('ignores variables it never writes, even ones a shell could not name', () => {
    const script = buildLinuxTerminalScript(scriptPlan({
      env: { HOME: '/home/a', PATH: '/usr/bin', 'BASH_FUNC_module%%': '() {  eval x\n}', SECRET: 'a\0b' },
    }))
    expect(script).not.toContain('BASH_FUNC')
    expect(script).not.toContain('SECRET')
  })

  it('rejects values that could escape their quoting or the title', () => {
    expect(() => buildLinuxTerminalScript(scriptPlan({ env: { HOME: '/home/a', PATH: '/usr/bin\0' } }))).toThrow(TypeError)
    expect(() => buildLinuxTerminalScript(scriptPlan({ argv: ['a\0b'] }))).toThrow(TypeError)
    expect(() => buildLinuxTerminalScript(scriptPlan({ title: 'x\u001b]0;evil\u0007' }))).toThrow(TypeError)
    expect(() => buildLinuxTerminalScript(scriptPlan({ executable: 'claude' }))).toThrow(TypeError)
    expect(() => buildLinuxTerminalScript(scriptPlan({ workspace: 'project' }))).toThrow(TypeError)
    expect(() => buildLinuxTerminalScript(scriptPlan({ env: { PATH: '/usr/bin' } }))).toThrow(TypeError)
  })

  describe.runIf(process.platform === 'linux')('run by the real /bin/sh', () => {
    function fakeCli(directory: string, exitCode: number): { executable: string; output: string } {
      const output = path.join(directory, 'result.txt')
      const executable = path.join(directory, 'fake-cli')
      fs.writeFileSync(executable, [
        '#!/bin/sh',
        `{ pwd; printf '%s\\n' "$@"; printf 'GEMINI=%s\\n' "\${GEMINI_API_KEY-unset}"; printf 'CODEX=%s\\n' "\${CODEX_HOME-unset}"; printf 'MODEL=%s\\n' "\${ANTHROPIC_MODEL-unset}"; } > '${output}'`,
        `exit ${exitCode}`,
        '',
      ].join('\n'), { mode: 0o700 })
      return { executable, output }
    }

    function run(script: string, launcherPath: string, env: NodeJS.ProcessEnv): string {
      fs.writeFileSync(launcherPath, script, { mode: 0o600 })
      return execFileSync('/bin/sh', [launcherPath], { env, input: '\n', encoding: 'utf8' })
    }

    it('starts the tool in the folder with literal arguments, prints the hint and removes the launcher', () => {
      const directory = temporaryDirectory('xingmang-linux-script-')
      const workspace = path.join(directory, "work $(touch nope) ' space")
      fs.mkdirSync(workspace)
      const { executable, output } = fakeCli(directory, 0)
      const launcherPath = path.join(directory, 'launch.sh')
      const argv = ['space value', "single'quote", '$HOME', '\n--leading']
      const stdout = run(buildLinuxTerminalScript({
        executable,
        argv,
        workspace,
        launcherPath,
        title: 'Claude Code · 星芒AI',
        env: { HOME: directory, PATH: '/usr/bin:/bin', GEMINI_API_KEY: 'sk-from-plan' },
      }), launcherPath, { PATH: '/usr/bin:/bin', CODEX_HOME: '/elsewhere', GEMINI_API_KEY: 'sk-from-server' })

      const recorded = fs.readFileSync(output, 'utf8').split('\n')
      expect(recorded[0]).toBe(workspace)
      expect(recorded.slice(1, 6)).toEqual(['space value', "single'quote", '$HOME', '', '--leading'])
      expect(recorded).toContain('GEMINI=sk-from-plan')
      expect(recorded).toContain('CODEX=unset')
      expect(fs.existsSync(launcherPath)).toBe(false)
      expect(fs.existsSync(path.join(workspace, 'nope'))).toBe(false)
      for (const line of cliExitHintLines.normal) expect(stdout).toContain(line)
      expect(stdout).toContain(cliCloseWindowPrompt)
    })

    it('keeps what the plan clears away from the tool even when the terminal server still has it', () => {
      const directory = temporaryDirectory('xingmang-linux-script-cleared-')
      const { executable, output } = fakeCli(directory, 0)
      const launcherPath = path.join(directory, 'launch.sh')
      const plan = {
        executable,
        argv: [],
        workspace: directory,
        launcherPath,
        title: 'Claude Code · 星芒AI',
        env: { HOME: directory, PATH: '/usr/bin:/bin' },
      }
      // 命令窗口程序自己的环境里还带着客户设的型号。
      const server = { PATH: '/usr/bin:/bin', ANTHROPIC_MODEL: 'deepseek-chat' }

      run(buildLinuxTerminalScript(plan), launcherPath, server)
      expect(fs.readFileSync(output, 'utf8').split('\n')).toContain('MODEL=deepseek-chat')

      run(buildLinuxTerminalScript({ ...plan, clearedEnvironmentKeys: ['ANTHROPIC_MODEL'] }), launcherPath, server)
      expect(fs.readFileSync(output, 'utf8').split('\n')).toContain('MODEL=unset')
    })

    it('prints the cautious hint when the tool fails', () => {
      const directory = temporaryDirectory('xingmang-linux-script-fail-')
      const { executable } = fakeCli(directory, 3)
      const launcherPath = path.join(directory, 'launch.sh')
      const stdout = run(buildLinuxTerminalScript({
        executable,
        argv: [],
        workspace: directory,
        launcherPath,
        title: 'Codex · 星芒AI',
        env: { HOME: directory, PATH: '/usr/bin:/bin' },
      }), launcherPath, { PATH: '/usr/bin:/bin' })
      for (const line of cliExitHintLines.unexpected) expect(stdout).toContain(line)
      expect(stdout).not.toContain(cliExitHintLines.normal[0])
    })

    it('explains an unreachable folder in Chinese and does not start the tool', () => {
      const directory = temporaryDirectory('xingmang-linux-script-gone-')
      const { executable, output } = fakeCli(directory, 0)
      const launcherPath = path.join(directory, 'launch.sh')
      let stdout = ''
      try {
        run(buildLinuxTerminalScript({
          executable,
          argv: [],
          workspace: path.join(directory, 'moved-away'),
          launcherPath,
          title: 'Gemini CLI · 星芒AI',
          env: { HOME: directory, PATH: '/usr/bin:/bin' },
        }), launcherPath, { PATH: '/usr/bin:/bin' })
      } catch (error) {
        stdout = String((error as { stdout?: unknown }).stdout ?? '')
      }
      for (const line of linuxFolderAccessHintLines) expect(stdout).toContain(line)
      expect(fs.existsSync(output)).toBe(false)
      expect(fs.existsSync(launcherPath)).toBe(false)
    })
  })
})

function fakeProcess(options: { spawnError?: string; exit?: number | string; onStart?: () => void } = {}): LinuxTerminalProcess {
  if (options.spawnError) {
    const error = Object.assign(new Error(`spawn ${options.spawnError}`), { code: options.spawnError })
    return { started: Promise.reject(error), exited: Promise.resolve(options.spawnError) }
  }
  setTimeout(() => options.onStart?.(), 5)
  return {
    started: Promise.resolve(),
    exited: options.exit === undefined ? new Promise(() => undefined) : Promise.resolve(options.exit),
  }
}

describe.runIf(process.platform !== 'win32')('launching a Linux terminal', () => {
  const candidates: LinuxTerminalCandidate[] = [
    { id: 'gnome-terminal', label: 'GNOME 终端', executable: '/usr/bin/gnome-terminal' },
    { id: 'xterm', label: 'XTerm', executable: '/usr/bin/xterm' },
  ]

  function plan(workspace: string) {
    return {
      executable: '/opt/tools/claude',
      argv: ['--model', 'opus'],
      workspace,
      title: 'Claude Code · 星芒AI',
      env: { HOME: workspace, PATH: '/usr/bin:/bin', GEMINI_API_KEY: 'sk-secret' },
    }
  }

  it('moves on when a terminal cannot start or fails, and succeeds once one runs the launcher', async () => {
    const base = temporaryDirectory('xingmang-linux-launch-')
    const calls: { executable: string; args: readonly string[] }[] = []
    const spawnTerminal: LinuxTerminalSpawner = (executable, args, options) => {
      calls.push({ executable, args })
      // Started outside the project folder: the launcher enters it and explains when it cannot.
      expect(options.cwd).toBe('/')
      if (calls.length === 1) return fakeProcess({ spawnError: 'ENOENT' })
      if (calls.length === 2) return fakeProcess({ exit: 1 })
      const launcherPath = args.at(-1) ?? ''
      // While it waits, the launcher is private and not executable.
      expect(fs.statSync(launcherPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(launcherPath)).mode & 0o777).toBe(0o700)
      return fakeProcess({ onStart: () => fs.unlinkSync(launcherPath) })
    }

    const result = await launchLinuxTerminal(plan(base), {
      findTerminals: () => [...candidates, { id: 'x-terminal-emulator', label: '系统默认终端', executable: '/usr/bin/x-terminal-emulator' }],
      spawnTerminal,
      launcherBaseDirectories: () => [base],
      pollIntervalMs: 5,
    })

    expect(result.terminal.id).toBe('x-terminal-emulator')
    expect(result.attempts).toEqual([
      { terminal: 'gnome-terminal', executable: '/usr/bin/gnome-terminal', outcome: 'spawn-failed', detail: 'ENOENT' },
      { terminal: 'xterm', executable: '/usr/bin/xterm', outcome: 'exited', detail: '1' },
    ])
    const launcherPath = calls[0]?.args.at(-1) ?? ''
    expect(calls.map((call) => call.args)).toEqual([
      ['--', '/bin/sh', launcherPath],
      ['-e', '/bin/sh', launcherPath],
      ['-e', '/bin/sh', launcherPath],
    ])
    expect(JSON.stringify(calls)).not.toContain('sk-secret')
    expect(JSON.stringify(calls)).not.toContain('/opt/tools/claude')
    expect(fs.readdirSync(base)).toEqual([])
  })

  it('keeps waiting while a client hands the window to its server', async () => {
    const base = temporaryDirectory('xingmang-linux-launch-server-')
    const result = await launchLinuxTerminal(plan(base), {
      findTerminals: () => candidates,
      spawnTerminal: (_executable, args) => {
        const launcherPath = args.at(-1) ?? ''
        setTimeout(() => fs.unlinkSync(launcherPath), 40)
        return fakeProcess({ exit: 0 })
      },
      launcherBaseDirectories: () => [base],
      pollIntervalMs: 5,
    })
    expect(result).toEqual({ terminal: candidates[0], attempts: [] })
  })

  it('gives up without opening a second window when the launcher never runs, and removes it', async () => {
    const base = temporaryDirectory('xingmang-linux-launch-timeout-')
    const calls: string[] = []
    const error = await launchLinuxTerminal(plan(base), {
      findTerminals: () => candidates,
      spawnTerminal: (executable) => {
        calls.push(executable)
        return fakeProcess({ exit: 0 })
      },
      launcherBaseDirectories: () => [base],
      waitMs: 30,
      pollIntervalMs: 5,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LinuxTerminalLaunchError)
    expect((error as LinuxTerminalLaunchError).message).toBe(linuxTerminalFailureMessages.notShown)
    expect((error as LinuxTerminalLaunchError).attempts).toEqual([
      { terminal: 'gnome-terminal', executable: '/usr/bin/gnome-terminal', outcome: 'timed-out', detail: null },
    ])
    expect(calls).toEqual(['/usr/bin/gnome-terminal'])
    expect(fs.readdirSync(base)).toEqual([])
  })

  it('says no terminal program was found, or none could start, in plain words', async () => {
    const base = temporaryDirectory('xingmang-linux-launch-none-')
    await expect(launchLinuxTerminal(plan(base), {
      findTerminals: () => [],
      launcherBaseDirectories: () => [base],
    })).rejects.toThrow(linuxTerminalFailureMessages.notFound)

    await expect(launchLinuxTerminal(plan(base), {
      findTerminals: () => candidates,
      spawnTerminal: () => fakeProcess({ spawnError: 'EACCES' }),
      launcherBaseDirectories: () => [base],
    })).rejects.toThrow(linuxTerminalFailureMessages.notStarted)
    expect(fs.readdirSync(base)).toEqual([])

    await expect(launchLinuxTerminal(plan(base), {
      findTerminals: () => candidates,
      launcherBaseDirectories: () => [],
    })).rejects.toThrow(linuxTerminalFailureMessages.noLauncherDirectory)
  })

  it('writes the launcher in the next temp directory when the first one cannot take it', async () => {
    const base = temporaryDirectory('xingmang-linux-launch-fallback-')
    const full = path.join(base, 'missing-runtime-dir')
    const spare = path.join(base, 'spare')
    fs.mkdirSync(spare, { mode: 0o700 })
    const launchers: string[] = []
    const result = await launchLinuxTerminal(plan(base), {
      findTerminals: () => candidates,
      spawnTerminal: (_executable, args) => {
        const launcherPath = args.at(-1) ?? ''
        launchers.push(launcherPath)
        return fakeProcess({ onStart: () => fs.unlinkSync(launcherPath) })
      },
      launcherBaseDirectories: () => [full, spare],
      pollIntervalMs: 5,
    })
    expect(result.terminal.id).toBe('gnome-terminal')
    expect(launchers[0]?.startsWith(`${spare}/`)).toBe(true)
    expect(fs.readdirSync(spare)).toEqual([])
  })

  it('reports an unusable temp directory in plain words and keeps the system error for the log', async () => {
    const base = temporaryDirectory('xingmang-linux-launch-no-dir-')
    const error = await launchLinuxTerminal(plan(base), {
      findTerminals: () => candidates,
      spawnTerminal: () => fakeProcess(),
      launcherBaseDirectories: () => [path.join(base, 'gone')],
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LinuxTerminalLaunchError)
    expect((error as LinuxTerminalLaunchError).message).toBe(linuxTerminalFailureMessages.noLauncherDirectory)
    expect((error as LinuxTerminalLaunchError).reason).toContain('ENOENT')
  })

  it('leaves nothing behind when the launcher cannot be built', async () => {
    const base = temporaryDirectory('xingmang-linux-launch-invalid-')
    await expect(launchLinuxTerminal({ ...plan(base), title: 'bad\u0007title' }, {
      findTerminals: () => candidates,
      spawnTerminal: () => fakeProcess(),
      launcherBaseDirectories: () => [base],
    })).rejects.toThrow(TypeError)
    expect(fs.readdirSync(base)).toEqual([])
  })

  it.runIf(process.platform === 'linux')('opens through a real terminal program and runs the tool in the chosen folder', async () => {
    const directory = temporaryDirectory('xingmang-linux-launch-e2e-')
    const base = path.join(directory, 'runtime')
    fs.mkdirSync(base, { mode: 0o700 })
    const workspace = path.join(directory, 'project')
    fs.mkdirSync(workspace)
    // A stand-in for x-terminal-emulator: drop `-e` and run the rest, as the Debian wrappers do.
    const terminal = path.join(directory, 'x-terminal-emulator')
    fs.writeFileSync(terminal, '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 })
    const output = path.join(directory, 'cli.txt')
    const cli = path.join(directory, 'cli')
    fs.writeFileSync(cli, `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; } > '${output}'\n`, { mode: 0o700 })

    const result = await launchLinuxTerminal({
      executable: cli,
      argv: ['--resume', 'a b'],
      workspace,
      title: 'Codex · 星芒AI',
      env: { HOME: directory, PATH: '/usr/bin:/bin' },
    }, {
      findTerminals: () => [{ id: 'x-terminal-emulator', label: '系统默认终端', executable: terminal }],
      launcherBaseDirectories: () => [base],
      pollIntervalMs: 10,
    })

    expect(result.terminal.executable).toBe(terminal)
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fs.readFileSync(output, 'utf8')).toBe(`${workspace}\n--resume\na b\n`)
    expect(fs.readdirSync(base)).toEqual([])
  })
})
