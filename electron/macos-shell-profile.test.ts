import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMacosFishProfile,
  buildMacosShellProfileBlock,
  ensureMacosShellProfile,
  macosShellProfileMarker,
  planMacosShellProfileAppend,
  planMacosShellProfileTarget,
  resolveMacosLoginShell,
} from './macos-shell-profile'

const temporaryDirectories: string[] = []

function homeDirectory(): string {
  // macOS puts the temp directory behind /var -> /private/var, which the
  // reparse-point guard would (rightly) refuse.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-zprofile-')))
  temporaryDirectories.push(directory)
  return directory
}

function stampPath(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'XingMangAI', 'terminal-commands-added')
}

function fishProfilePath(home: string): string {
  return path.join(home, '.config', 'fish', 'conf.d', 'xingmang-ai-manager.fish')
}

/** Where the shell lives on macOS and most Linux systems, or null when it is not installed. */
function findShell(name: string): string | null {
  return ['/bin', '/usr/bin'].map((directory) => path.join(directory, name)).find((candidate) => fs.existsSync(candidate)) ?? null
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('buildMacosShellProfileBlock', () => {
  it('appends the managed CLI, Grok and app-downloaded Node directories after the existing PATH', () => {
    const block = buildMacosShellProfileBlock()
    expect(block.startsWith(`${macosShellProfileMarker}\n`)).toBe(true)
    expect(block).toContain('"$HOME/Library/Application Support/XingMangAI/Cli/npm/bin"')
    expect(block).toContain('"$HOME/.grok/bin"')
    expect(block).toContain('export PATH="$PATH:$xingmang_dir"')
    // The user's own Node must be found before the one the app downloaded.
    expect(block.indexOf('Runtime/node/bin')).toBeGreaterThan(block.indexOf('Cli/npm/bin'))
    expect(block.endsWith('\n')).toBe(true)
  })

  it.runIf(fs.existsSync('/bin/sh'))('adds each directory once, even when the profile is read twice', () => {
    const home = '/Users/ann'
    const script = `${buildMacosShellProfileBlock()}${buildMacosShellProfileBlock()}printf '%s' "$PATH"`
    const result = execFileSync('/bin/sh', ['-c', script], { env: { HOME: home, PATH: '/usr/bin:/bin' } }).toString()
    expect(result).toBe([
      '/usr/bin',
      '/bin',
      '/Users/ann/Library/Application Support/XingMangAI/Cli/npm/bin',
      '/Users/ann/.grok/bin',
      '/Users/ann/Library/Application Support/XingMangAI/Runtime/node/bin',
    ].join(':'))
  })
})

describe('buildMacosFishProfile', () => {
  it('appends the same directories in the same order, in fish syntax between the same markers', () => {
    const profile = buildMacosFishProfile()
    expect(profile.startsWith(`${macosShellProfileMarker}\n`)).toBe(true)
    expect(profile.endsWith('# <<< xingmang-ai-manager terminal commands <<<\n')).toBe(true)
    expect(profile).toContain('if not contains -- "$HOME/.grok/bin" $PATH')
    expect([...profile.matchAll(/set -gx PATH \$PATH "([^"]+)"/g)].map((match) => match[1])).toEqual([
      '$HOME/Library/Application Support/XingMangAI/Cli/npm/bin',
      '$HOME/.grok/bin',
      '$HOME/Library/Application Support/XingMangAI/Runtime/node/bin',
    ])
  })
})

describe('planMacosShellProfileAppend', () => {
  it('writes just the block into a missing or empty profile', () => {
    expect(planMacosShellProfileAppend(null)).toBe(buildMacosShellProfileBlock())
    expect(planMacosShellProfileAppend('')).toBe(buildMacosShellProfileBlock())
  })

  it('keeps a blank line between the user lines and the block', () => {
    expect(planMacosShellProfileAppend('eval "$(/opt/homebrew/bin/brew shellenv)"\n'))
      .toBe(`\n${buildMacosShellProfileBlock()}`)
    expect(planMacosShellProfileAppend('export A=1'))
      .toBe(`\n\n${buildMacosShellProfileBlock()}`)
  })

  it('adds nothing when the block is already there', () => {
    expect(planMacosShellProfileAppend(`export A=1\n\n${buildMacosShellProfileBlock()}`)).toBe('')
  })
})

describe('resolveMacosLoginShell', () => {
  it('knows zsh, bash and fish wherever they live and nothing else', () => {
    expect(resolveMacosLoginShell('/bin/zsh')).toBe('zsh')
    expect(resolveMacosLoginShell('/opt/homebrew/bin/zsh')).toBe('zsh')
    expect(resolveMacosLoginShell('/bin/bash')).toBe('bash')
    expect(resolveMacosLoginShell('/usr/local/bin/bash')).toBe('bash')
    expect(resolveMacosLoginShell('/opt/homebrew/bin/fish')).toBe('fish')
    expect(resolveMacosLoginShell('/bin/tcsh')).toBeNull()
    expect(resolveMacosLoginShell('/bin/sh')).toBeNull()
    expect(resolveMacosLoginShell('')).toBeNull()
    expect(resolveMacosLoginShell(null)).toBeNull()
  })
})

describe('planMacosShellProfileTarget', () => {
  function target(shell: 'zsh' | 'bash' | 'fish', existing: readonly string[] = []) {
    return planMacosShellProfileTarget({
      shell,
      homeDirectory: '/Users/ann',
      fishConfigDirectory: '/Users/ann/.config/fish',
      exists: (filePath) => existing.includes(filePath),
    })
  }

  it('keeps zsh on ~/.zprofile whatever else is there', () => {
    expect(target('zsh', ['/Users/ann/.bash_profile', '/Users/ann/.profile']))
      .toEqual({ kind: 'posix', filePath: '/Users/ann/.zprofile', displayPath: '~/.zprofile' })
  })

  it('picks for bash the first of its login files that exists, the only one it reads', () => {
    expect(target('bash', ['/Users/ann/.bash_profile', '/Users/ann/.bash_login', '/Users/ann/.profile']).displayPath).toBe('~/.bash_profile')
    expect(target('bash', ['/Users/ann/.bash_login', '/Users/ann/.profile']).displayPath).toBe('~/.bash_login')
    expect(target('bash', ['/Users/ann/.profile'])).toEqual({ kind: 'posix', filePath: '/Users/ann/.profile', displayPath: '~/.profile' })
  })

  it('creates ~/.profile for bash when it has none of them, never ~/.bash_profile', () => {
    expect(target('bash', ['/Users/ann/.zprofile', '/Users/ann/.bashrc']))
      .toEqual({ kind: 'posix', filePath: '/Users/ann/.profile', displayPath: '~/.profile' })
  })

  it('gives fish a conf.d file of its own', () => {
    expect(target('fish', ['/Users/ann/.zprofile'])).toEqual({
      kind: 'fish',
      filePath: '/Users/ann/.config/fish/conf.d/xingmang-ai-manager.fish',
      displayPath: 'fish/conf.d/xingmang-ai-manager.fish',
    })
  })
})

// Writes real startup files under a POSIX home; the code only ever runs on macOS,
// and a Windows temp directory is not a POSIX absolute path.
describe.runIf(process.platform !== 'win32')('ensureMacosShellProfile', () => {
  it('creates ~/.zprofile with the block and records that it did', async () => {
    const home = homeDirectory()

    await expect(ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/zsh' })).resolves.toBe('added')

    expect(fs.readFileSync(path.join(home, '.zprofile'), 'utf8')).toBe(buildMacosShellProfileBlock())
  })

  it('appends after what the user wrote and is a no-op the second time', async () => {
    const home = homeDirectory()
    const profile = path.join(home, '.zprofile')
    fs.writeFileSync(profile, 'eval "$(/opt/homebrew/bin/brew shellenv)"\n')

    await expect(ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/zsh' })).resolves.toBe('added')
    await expect(ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/zsh' })).resolves.toBe('present')

    expect(fs.readFileSync(profile, 'utf8')).toBe(`eval "$(/opt/homebrew/bin/brew shellenv)"\n\n${buildMacosShellProfileBlock()}`)
  })

  it('at startup leaves a profile alone once it has been handled, so a removed block stays removed', async () => {
    const home = homeDirectory()
    fs.mkdirSync(path.dirname(stampPath(home)), { recursive: true })

    await expect(ensureMacosShellProfile({ reason: 'startup', homeDirectory: home, loginShell: '/bin/zsh' })).resolves.toBe('added')
    expect(fs.existsSync(stampPath(home))).toBe(true)
    fs.writeFileSync(path.join(home, '.zprofile'), 'export A=1\n')

    await expect(ensureMacosShellProfile({ reason: 'startup', homeDirectory: home, loginShell: '/bin/zsh' })).resolves.toBe('already-handled')
    expect(fs.readFileSync(path.join(home, '.zprofile'), 'utf8')).toBe('export A=1\n')

    // Installing a tool again is an explicit ask, so the block comes back.
    await expect(ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/zsh' })).resolves.toBe('added')
  })

  it('does not write anything, the record included, for a login shell it does not handle', async () => {
    const home = homeDirectory()

    await expect(ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/tcsh' })).resolves.toBe('unsupported-shell')

    expect(fs.readdirSync(home)).toEqual([])
  })

  it('refuses to write through a symlinked profile', async () => {
    const home = homeDirectory()
    const target = path.join(home, 'dotfiles-zprofile')
    fs.writeFileSync(target, 'export A=1\n')
    fs.symlinkSync(target, path.join(home, '.zprofile'))

    await expect(ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/zsh' })).rejects.toThrow('终端启动设置')

    expect(fs.readFileSync(target, 'utf8')).toBe('export A=1\n')
  })

  describe('for a bash account', () => {
    function ensure(home: string, reason: 'install' | 'startup' = 'install') {
      return ensureMacosShellProfile({ reason, homeDirectory: home, loginShell: '/bin/bash' })
    }

    it('appends to an existing ~/.bash_profile and leaves ~/.profile, which bash then skips, alone', async () => {
      const home = homeDirectory()
      fs.writeFileSync(path.join(home, '.bash_profile'), 'source ~/.bashrc\n')
      fs.writeFileSync(path.join(home, '.profile'), 'export A=1\n')

      await expect(ensure(home)).resolves.toBe('added')
      await expect(ensure(home)).resolves.toBe('present')

      expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toBe(`source ~/.bashrc\n\n${buildMacosShellProfileBlock()}`)
      expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe('export A=1\n')
    })

    it('appends to ~/.profile when that is the only one', async () => {
      const home = homeDirectory()
      fs.writeFileSync(path.join(home, '.profile'), 'export A=1')

      await expect(ensure(home)).resolves.toBe('added')

      expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe(`export A=1\n\n${buildMacosShellProfileBlock()}`)
      expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false)
    })

    it('creates ~/.profile, never ~/.bash_profile, when there is neither', async () => {
      const home = homeDirectory()

      await expect(ensure(home)).resolves.toBe('added')

      expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe(buildMacosShellProfileBlock())
      expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false)
    })

    it('catches up at startup on a computer that was skipped before, then only once', async () => {
      // Back when only zsh was handled, nothing was written for this account, not even the record.
      const home = homeDirectory()
      fs.mkdirSync(path.dirname(stampPath(home)), { recursive: true })

      await expect(ensure(home, 'startup')).resolves.toBe('added')
      await expect(ensure(home, 'startup')).resolves.toBe('already-handled')

      expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe(buildMacosShellProfileBlock())
    })

    it('refuses a symlinked ~/.bash_profile instead of falling back to a ~/.profile bash would not read', async () => {
      const home = homeDirectory()
      const dotfile = path.join(home, 'dotfiles-bash_profile')
      fs.writeFileSync(dotfile, 'export A=1\n')
      fs.symlinkSync(dotfile, path.join(home, '.bash_profile'))
      fs.writeFileSync(path.join(home, '.profile'), 'export B=1\n')

      await expect(ensure(home)).rejects.toThrow('终端启动设置（~/.bash_profile）')

      expect(fs.readFileSync(dotfile, 'utf8')).toBe('export A=1\n')
      expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe('export B=1\n')
    })

    it('refuses a ~/.profile with a second hard link', async () => {
      const home = homeDirectory()
      fs.writeFileSync(path.join(home, '.profile'), 'export A=1\n')
      fs.linkSync(path.join(home, '.profile'), path.join(home, 'profile-backup'))

      await expect(ensure(home)).rejects.toThrow('终端启动设置（~/.profile）')

      expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe('export A=1\n')
    })
  })

  describe('for a fish account', () => {
    function ensure(home: string, env: NodeJS.ProcessEnv = {}) {
      return ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/opt/homebrew/bin/fish', env })
    }

    it('creates a conf.d file of its own instead of editing config.fish, once', async () => {
      const home = homeDirectory()
      const configFish = path.join(home, '.config', 'fish', 'config.fish')
      fs.mkdirSync(path.dirname(configFish), { recursive: true })
      fs.writeFileSync(configFish, 'set -g fish_greeting\n')

      await expect(ensure(home)).resolves.toBe('added')
      await expect(ensure(home)).resolves.toBe('present')

      expect(fs.readFileSync(configFish, 'utf8')).toBe('set -g fish_greeting\n')
      expect(fs.readFileSync(fishProfilePath(home), 'utf8')).toBe(buildMacosFishProfile())
      expect(fs.existsSync(path.join(home, '.zprofile'))).toBe(false)
    })

    it('follows XDG_CONFIG_HOME', async () => {
      const home = homeDirectory()
      const configHome = homeDirectory()

      await expect(ensure(home, { XDG_CONFIG_HOME: configHome })).resolves.toBe('added')

      expect(fs.readFileSync(path.join(configHome, 'fish', 'conf.d', 'xingmang-ai-manager.fish'), 'utf8')).toBe(buildMacosFishProfile())
      expect(fs.existsSync(path.join(home, '.config'))).toBe(false)
    })

    it('leaves a conf.d file of the same name it did not write alone', async () => {
      const home = homeDirectory()
      fs.mkdirSync(path.dirname(fishProfilePath(home)), { recursive: true })
      fs.writeFileSync(fishProfilePath(home), 'set -gx A 1\n')

      await expect(ensure(home)).rejects.toThrow('终端启动设置（fish/conf.d/xingmang-ai-manager.fish）已被别的内容占用')

      expect(fs.readFileSync(fishProfilePath(home), 'utf8')).toBe('set -gx A 1\n')
    })
  })
})

// The promise itself: a new Terminal window, which starts a login shell, runs
// what the app installed by name. Each shell runs wherever it is installed
// (CI's macOS runner has zsh and bash). The command gets a name of its own: a
// real `claude` the machine already has, earlier on PATH, rightly wins.
describe.runIf(process.platform !== 'win32')('a new login shell after the check', () => {
  const zsh = findShell('zsh')
  const bash = findShell('bash')
  const fish = findShell('fish')

  function installProbe(home: string): string {
    const bin = path.join(home, 'Library', 'Application Support', 'XingMangAI', 'Cli', 'npm', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const target = path.join(bin, 'xingmang-probe')
    fs.writeFileSync(target, '#!/bin/sh\necho probe\n', { mode: 0o755 })
    return target
  }

  function loginShellOutput(shell: string, home: string, command: string): string {
    const result = spawnSync(shell, ['-l', '-c', command], { env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, cwd: home })
    return result.stdout.toString()
  }

  it.runIf(zsh !== null)('zsh finds it by name', async () => {
    const home = homeDirectory()
    const probe = installProbe(home)

    await ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/zsh' })

    expect(loginShellOutput(zsh ?? '', home, 'command -v xingmang-probe')).toBe(`${probe}\n`)
  })

  it.runIf(bash !== null)('bash finds it by name, whichever of its login files it reads', async () => {
    const layouts: Array<Record<string, string>> = [
      { '.bash_profile': 'export A=1\n', '.profile': 'export B=1\n' },
      { '.profile': 'export B=1\n' },
      {},
    ]
    for (const files of layouts) {
      const home = homeDirectory()
      const probe = installProbe(home)
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(home, name), content)

      await ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/bash' })

      expect(loginShellOutput(bash ?? '', home, 'command -v xingmang-probe')).toBe(`${probe}\n`)
    }
  })

  it.runIf(fish !== null)('fish finds it by name and lists each folder once, even when the file is read again', async () => {
    const home = homeDirectory()
    const probe = installProbe(home)

    await ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/opt/homebrew/bin/fish', env: {} })

    expect(loginShellOutput(fish ?? '', home, 'command -v xingmang-probe')).toBe(`${probe}\n`)
    const entries = loginShellOutput(fish ?? '', home, `source '${fishProfilePath(home)}'; printf '%s\\n' $PATH`).split('\n')
    expect(entries.filter((entry) => entry === path.dirname(probe))).toHaveLength(1)
    expect(entries.filter((entry) => entry === path.join(home, '.grok', 'bin'))).toHaveLength(1)
  })
})
