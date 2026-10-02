import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLauncherDirectoryWords,
  buildLinuxFishProfile,
  buildLinuxShellProfileBlock,
  buildLinuxTerminalLauncher,
  linuxShellProfileMarker,
  planLinuxShellProfileAppend,
  planLinuxShellProfileRemoval,
  planLinuxShellProfileTargets,
  syncLinuxTerminalCommands,
} from './linux-shell-profile'

const temporaryDirectories: string[] = []
const defaultLaunchers = '/home/ann/.local/share/XingMangAI/Cli/launchers'

function homeDirectory(): string {
  // macOS puts the temp directory behind /var -> /private/var, which the
  // reparse-point guard would (rightly) refuse.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-profile-')))
  temporaryDirectories.push(directory)
  return directory
}

function productRoot(home: string): string {
  return path.join(home, '.local', 'share', 'XingMangAI')
}

function launcherDirectory(home: string): string {
  return path.join(productRoot(home), 'Cli', 'launchers')
}

/** Puts an entry point where the app's npm install would, so the sync sees the CLI as installed. */
function installManaged(home: string, command: string, content = `#!/bin/sh\necho "${command}:$*"\n`): string {
  const bin = path.join(productRoot(home), 'Cli', 'npm', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const target = path.join(bin, command)
  fs.writeFileSync(target, content, { mode: 0o755 })
  return target
}

function env(home: string): NodeJS.ProcessEnv {
  return { HOME: home }
}

function hasShell(name: string): boolean {
  return ['/usr/bin', '/bin'].some((directory) => fs.existsSync(path.join(directory, name)))
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('buildLauncherDirectoryWords', () => {
  it('writes the default data folder through $HOME', () => {
    expect(buildLauncherDirectoryWords(defaultLaunchers, '/home/ann')).toEqual({
      posix: '$HOME/.local/share/XingMangAI/Cli/launchers',
      fish: '$HOME/.local/share/XingMangAI/Cli/launchers',
    })
  })

  it('writes a custom data folder as an absolute path escaped for double quotes', () => {
    expect(buildLauncherDirectoryWords('/data/a "b" $c `d`/XingMangAI/Cli/launchers', '/home/ann')).toEqual({
      posix: '/data/a \\"b\\" \\$c \\`d\\`/XingMangAI/Cli/launchers',
      fish: '/data/a \\"b\\" \\$c `d`/XingMangAI/Cli/launchers',
    })
  })

  it('refuses a folder that would split into two entries or is not absolute', () => {
    expect(() => buildLauncherDirectoryWords('/data/a:b/XingMangAI/Cli/launchers', '/home/ann')).toThrow('终端启动器目录无效')
    expect(() => buildLauncherDirectoryWords('data/XingMangAI/Cli/launchers', '/home/ann')).toThrow('终端启动器目录无效')
  })
})

describe('buildLinuxShellProfileBlock', () => {
  it('appends only the launcher folder after the existing PATH, between the shared markers', () => {
    const block = buildLinuxShellProfileBlock(defaultLaunchers, '/home/ann')
    expect(block.startsWith(`${linuxShellProfileMarker}\n`)).toBe(true)
    expect(block).toContain('export PATH="$PATH:$HOME/.local/share/XingMangAI/Cli/launchers"')
    // Neither the npm folder nor the app's Node.js goes on the user's PATH.
    expect(block).not.toContain('Cli/npm')
    expect(block).not.toContain('Runtime/node')
    expect(block.endsWith('# <<< xingmang-ai-manager terminal commands <<<\n')).toBe(true)
  })

  it.runIf(fs.existsSync('/bin/sh'))('adds the folder once, even when two startup files are read', () => {
    const block = buildLinuxShellProfileBlock(defaultLaunchers, '/home/ann')
    const result = execFileSync('/bin/sh', ['-c', `${block}${block}printf '%s' "$PATH"`], {
      env: { HOME: '/home/ann', PATH: '/usr/bin:/bin' },
    }).toString()
    expect(result).toBe(`/usr/bin:/bin:${defaultLaunchers}`)
  })

  it.runIf(fs.existsSync('/bin/sh'))('keeps a custom folder with shell characters literal', () => {
    const directory = '/data/a "b" $HOME `id`/XingMangAI/Cli/launchers'
    const block = buildLinuxShellProfileBlock(directory, '/home/ann')
    const result = execFileSync('/bin/sh', ['-c', `${block}${block}printf '%s' "$PATH"`], {
      env: { HOME: '/home/ann', PATH: '/usr/bin' },
    }).toString()
    expect(result).toBe(`/usr/bin:${directory}`)
  })
})

describe('buildLinuxFishProfile', () => {
  it('uses fish syntax and the same markers', () => {
    const profile = buildLinuxFishProfile(defaultLaunchers, '/home/ann')
    expect(profile.startsWith(`${linuxShellProfileMarker}\n`)).toBe(true)
    expect(profile).toContain('if not contains -- "$HOME/.local/share/XingMangAI/Cli/launchers" $PATH')
    expect(profile).toContain('set -gx PATH $PATH "$HOME/.local/share/XingMangAI/Cli/launchers"')
  })
})

describe('planLinuxShellProfileAppend', () => {
  const block = buildLinuxShellProfileBlock(defaultLaunchers, '/home/ann')

  it('writes just the block into a missing or empty file and keeps a blank line after user lines', () => {
    expect(planLinuxShellProfileAppend(null, block)).toBe(block)
    expect(planLinuxShellProfileAppend('', block)).toBe(block)
    expect(planLinuxShellProfileAppend('alias ll="ls -l"\n', block)).toBe(`\n${block}`)
    expect(planLinuxShellProfileAppend('alias ll="ls -l"', block)).toBe(`\n\n${block}`)
  })

  it('adds nothing when a block is already there', () => {
    expect(planLinuxShellProfileAppend(`export A=1\n\n${block}`, block)).toBe('')
  })
})

describe('planLinuxShellProfileRemoval', () => {
  const block = buildLinuxShellProfileBlock(defaultLaunchers, '/home/ann')

  it('gives back exactly what was there before the append', () => {
    for (const original of ['', 'export A=1\n', 'export A=1\n\n', '# only a comment\nexport B=2\n']) {
      expect(planLinuxShellProfileRemoval(`${original}${planLinuxShellProfileAppend(original, block)}`, block)).toBe(original)
    }
    // A file that had no final newline gets one: the append had to add it.
    expect(planLinuxShellProfileRemoval(`export A=1${planLinuxShellProfileAppend('export A=1', block)}`, block)).toBe('export A=1\n')
  })

  it('keeps lines the user added after the block', () => {
    const current = `export A=1\n${planLinuxShellProfileAppend('export A=1\n', block)}export B=2\n`
    expect(planLinuxShellProfileRemoval(current, block)).toBe('export A=1\nexport B=2\n')
  })

  it('also finds the block when the final newline was deleted', () => {
    expect(planLinuxShellProfileRemoval(`export A=1\n\n${block.slice(0, -1)}`, block)).toBe('export A=1\n')
  })

  it('leaves an edited block, or one that does not start a line, alone', () => {
    const edited = block.replace('esac', 'esac\nexport C=3')
    expect(planLinuxShellProfileRemoval(`export A=1\n\n${edited}`, block)).toBeNull()
    expect(planLinuxShellProfileRemoval(`echo ${block}`, block)).toBeNull()
    expect(planLinuxShellProfileRemoval('export A=1\n', block)).toBeNull()
  })
})

describe('buildLinuxTerminalLauncher', () => {
  it('quotes both paths and refuses a command name that is not a plain word', () => {
    const launcher = buildLinuxTerminalLauncher('claude', "/home/o'neil/bin/claude", '/home/o\'neil/node/bin')
    expect(launcher.startsWith('#!/bin/sh\n# xingmang-ai-manager terminal launcher\n')).toBe(true)
    expect(launcher).toContain("xingmang_target='/home/o'\\''neil/bin/claude'")
    expect(launcher).toContain('exec "$xingmang_target" "$@"')
    expect(() => buildLinuxTerminalLauncher('claude; rm -rf ~', '/a', '/b')).toThrow('命令名无效')
    expect(() => buildLinuxTerminalLauncher('claude', 'relative', '/b')).toThrow()
  })

  describe.runIf(process.platform !== 'win32' && fs.existsSync('/bin/sh'))('when run', () => {
    function fixture(withNode: boolean) {
      const root = homeDirectory()
      const oldBin = path.join(root, 'old-bin')
      const nodeBin = path.join(root, 'node', 'bin')
      fs.mkdirSync(oldBin, { recursive: true })
      fs.mkdirSync(nodeBin, { recursive: true })
      // The distro Node.js that is too old, first on the user's PATH.
      fs.writeFileSync(path.join(oldBin, 'node'), '#!/bin/sh\necho "old-node"\n', { mode: 0o755 })
      if (withNode) fs.writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\necho "managed-node $#:$2"\n', { mode: 0o755 })
      // An npm entry point: the shebang decides which Node.js runs it.
      const target = path.join(root, 'cli.js')
      fs.writeFileSync(target, '#!/usr/bin/env node\n', { mode: 0o755 })
      const launcher = path.join(root, 'claude')
      fs.writeFileSync(launcher, buildLinuxTerminalLauncher('claude', target, nodeBin), { mode: 0o700 })
      return { launcher, target, path: `${oldBin}:/usr/bin:/bin` }
    }

    it("runs the CLI under the app's Node.js instead of an older one earlier on PATH", () => {
      const { launcher, path: searchPath } = fixture(true)
      const result = spawnSync(launcher, ['two words'], { env: { PATH: searchPath } })
      expect(result.status).toBe(0)
      expect(result.stdout.toString()).toBe('managed-node 2:two words\n')
    })

    it('leaves the search order alone when the app never downloaded Node.js', () => {
      const { launcher, path: searchPath } = fixture(false)
      const result = spawnSync(launcher, [], { env: { PATH: searchPath } })
      expect(result.stdout.toString()).toBe('old-node\n')
    })

    it('says in plain words that the CLI is gone instead of a shell error', () => {
      const { launcher, target, path: searchPath } = fixture(true)
      fs.rmSync(target)
      const result = spawnSync(launcher, [], { env: { PATH: searchPath } })
      expect(result.status).toBe(127)
      expect(result.stderr.toString()).toBe('找不到星芒AI管理工具装的 claude，请打开星芒AI管理工具重新安装。\n')
    })
  })
})

describe('planLinuxShellProfileTargets', () => {
  function targets(loginShell: string | null, existing: readonly string[] = []) {
    return planLinuxShellProfileTargets({
      homeDirectory: '/home/ann',
      fishConfigDirectory: '/home/ann/.config/fish',
      loginShell,
      exists: (filePath) => existing.includes(filePath),
    }).map((target) => target.displayPath)
  }

  it("creates the files the account's own shell reads", () => {
    expect(targets('/bin/bash')).toEqual(['~/.bashrc', '~/.profile'])
    expect(targets('/usr/bin/zsh')).toEqual(['~/.zshrc'])
    expect(targets('/bin/sh')).toEqual(['~/.profile'])
    expect(targets('/usr/bin/fish')).toEqual(['fish/conf.d/xingmang-ai-manager.fish'])
  })

  it('also adds to files that already exist, whatever the account shell is', () => {
    expect(targets('/usr/bin/zsh', ['/home/ann/.bashrc', '/home/ann/.profile', '/home/ann/.config/fish']))
      .toEqual(['~/.bashrc', '~/.zshrc', '~/.profile', 'fish/conf.d/xingmang-ai-manager.fish'])
  })

  it('creates nothing for a shell it does not know, and never ~/.bash_profile', () => {
    expect(targets('/bin/tcsh')).toEqual([])
    expect(targets(null)).toEqual([])
    expect(targets('/bin/bash').some((target) => target.includes('bash_profile'))).toBe(false)
  })
})

// Writes real startup files under a POSIX home; the code only ever runs on Linux.
describe.runIf(process.platform !== 'win32')('syncLinuxTerminalCommands', () => {
  function block(home: string): string {
    return buildLinuxShellProfileBlock(launcherDirectory(home), home)
  }

  it('writes a launcher for each CLI the app installed and the lines for a bash account', async () => {
    const home = homeDirectory()
    installManaged(home, 'claude')
    installManaged(home, 'codex')

    await expect(syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toEqual({ outcome: 'added', launchers: ['claude', 'codex'], skipped: [] })

    expect(fs.readdirSync(launcherDirectory(home)).sort()).toEqual(['claude', 'codex'])
    expect(fs.statSync(path.join(launcherDirectory(home), 'claude')).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe(block(home))
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe(block(home))
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false)
    expect(fs.existsSync(path.join(productRoot(home), 'terminal-commands-added'))).toBe(true)
  })

  it('appends after what the user wrote and is a no-op the second time', async () => {
    const home = homeDirectory()
    installManaged(home, 'claude')
    const bashrc = path.join(home, '.bashrc')
    fs.writeFileSync(bashrc, 'alias ll="ls -l"\n', { mode: 0o644 })

    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })
    await expect(syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toMatchObject({ outcome: 'present' })

    expect(fs.readFileSync(bashrc, 'utf8')).toBe(`alias ll="ls -l"\n\n${block(home)}`)
  })

  it('writes nothing at all when the app has no CLI installed', async () => {
    const home = homeDirectory()

    await expect(syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toEqual({ outcome: 'not-needed', launchers: [], skipped: [] })

    expect(fs.readdirSync(home)).toEqual([])
  })

  it('at startup keeps a removed block removed but still brings the launchers in line', async () => {
    const home = homeDirectory()
    installManaged(home, 'claude')
    await syncLinuxTerminalCommands({ reason: 'startup', env: env(home), loginShell: '/bin/bash' })
    fs.writeFileSync(path.join(home, '.bashrc'), 'export A=1\n')
    installManaged(home, 'gemini')

    await expect(syncLinuxTerminalCommands({ reason: 'startup', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toMatchObject({ outcome: 'already-handled', launchers: ['claude', 'gemini'] })
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('export A=1\n')

    // Installing a tool again is an explicit ask, so the block comes back.
    await expect(syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toMatchObject({ outcome: 'added' })
  })

  it('creates a conf.d file for fish instead of editing config.fish', async () => {
    const home = homeDirectory()
    installManaged(home, 'codex')
    const configFish = path.join(home, '.config', 'fish', 'config.fish')
    fs.mkdirSync(path.dirname(configFish), { recursive: true })
    fs.writeFileSync(configFish, 'set -g fish_greeting\n')

    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/usr/bin/fish' })

    expect(fs.readFileSync(configFish, 'utf8')).toBe('set -g fish_greeting\n')
    expect(fs.readFileSync(path.join(home, '.config', 'fish', 'conf.d', 'xingmang-ai-manager.fish'), 'utf8'))
      .toBe(buildLinuxFishProfile(launcherDirectory(home), home))
  })

  it('follows XDG_DATA_HOME and writes that folder as an absolute path', async () => {
    const home = homeDirectory()
    const dataHome = homeDirectory()
    const bin = path.join(dataHome, 'XingMangAI', 'Cli', 'npm', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })

    await syncLinuxTerminalCommands({ reason: 'install', env: { HOME: home, XDG_DATA_HOME: dataHome }, loginShell: '/bin/bash' })

    expect(fs.existsSync(path.join(dataHome, 'XingMangAI', 'Cli', 'launchers', 'claude'))).toBe(true)
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'))
      .toContain(`export PATH="$PATH:${dataHome}/XingMangAI/Cli/launchers"`)
  })

  it('leaves a symlinked startup file to its owner and still updates the others', async () => {
    const home = homeDirectory()
    installManaged(home, 'claude')
    const dotfile = path.join(home, 'dotfiles-bashrc')
    fs.writeFileSync(dotfile, 'export A=1\n')
    fs.symlinkSync(dotfile, path.join(home, '.bashrc'))

    await expect(syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toEqual({ outcome: 'added', launchers: ['claude'], skipped: ['~/.bashrc'] })

    expect(fs.readFileSync(dotfile, 'utf8')).toBe('export A=1\n')
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe(block(home))
  })

  it('after an uninstall drops that launcher and keeps the lines while another CLI is left', async () => {
    const home = homeDirectory()
    const claude = installManaged(home, 'claude')
    installManaged(home, 'codex')
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })
    fs.rmSync(claude)

    await expect(syncLinuxTerminalCommands({ reason: 'uninstall', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toEqual({ outcome: 'not-needed', launchers: ['codex'], skipped: [] })

    expect(fs.readdirSync(launcherDirectory(home))).toEqual(['codex'])
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe(block(home))
  })

  it('after the last uninstall takes out exactly what it added, keeping file modes and user lines', async () => {
    const home = homeDirectory()
    const codex = installManaged(home, 'codex')
    const bashrc = path.join(home, '.bashrc')
    const zshrc = path.join(home, '.zshrc')
    fs.writeFileSync(bashrc, 'alias ll="ls -l"\n', { mode: 0o644 })
    fs.writeFileSync(zshrc, 'setopt autocd', { mode: 0o640 })
    fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true })
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })
    fs.appendFileSync(bashrc, 'export AFTER=1\n')
    fs.rmSync(codex)

    // The account shell changed since: removal looks at every file it may have touched.
    await expect(syncLinuxTerminalCommands({ reason: 'uninstall', env: env(home), loginShell: '/usr/bin/zsh' }))
      .resolves.toEqual({ outcome: 'removed', launchers: [], skipped: [] })

    expect(fs.readFileSync(bashrc, 'utf8')).toBe('alias ll="ls -l"\nexport AFTER=1\n')
    expect(fs.statSync(bashrc).mode & 0o777).toBe(0o644)
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('setopt autocd\n')
    expect(fs.statSync(zshrc).mode & 0o777).toBe(0o640)
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe('')
    expect(fs.existsSync(path.join(home, '.config', 'fish', 'conf.d', 'xingmang-ai-manager.fish'))).toBe(false)
    expect(fs.existsSync(launcherDirectory(home))).toBe(false)
  })

  it('keeps a block the user edited and a launcher-folder file it did not write', async () => {
    const home = homeDirectory()
    const claude = installManaged(home, 'claude')
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })
    const bashrc = path.join(home, '.bashrc')
    const edited = fs.readFileSync(bashrc, 'utf8').replace('esac', 'esac\nexport MINE=1')
    fs.writeFileSync(bashrc, edited)
    fs.writeFileSync(path.join(launcherDirectory(home), 'codex'), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    fs.rmSync(claude)

    await syncLinuxTerminalCommands({ reason: 'uninstall', env: env(home), loginShell: '/bin/bash' })

    expect(fs.readFileSync(bashrc, 'utf8')).toBe(edited)
    expect(fs.readFileSync(path.join(launcherDirectory(home), 'codex'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
    expect(fs.existsSync(path.join(launcherDirectory(home), 'claude'))).toBe(false)
  })

  it('never takes the lines out at startup, even when it finds nothing installed', async () => {
    const home = homeDirectory()
    const claude = installManaged(home, 'claude')
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })
    fs.rmSync(claude)

    await expect(syncLinuxTerminalCommands({ reason: 'startup', env: env(home), loginShell: '/bin/bash' }))
      .resolves.toMatchObject({ outcome: 'not-needed' })

    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe(block(home))
  })
})

// The end-to-end promise: a terminal the user opens runs the CLI by name, under
// the app's Node.js, while their own `node` stays what it was.
describe.runIf(process.platform === 'linux' && hasShell('bash'))('a new bash after the sync', () => {
  function prepared() {
    const home = homeDirectory()
    const oldBin = path.join(home, 'old-bin')
    fs.mkdirSync(oldBin)
    fs.writeFileSync(path.join(oldBin, 'node'), '#!/bin/sh\necho "old-node"\n', { mode: 0o755 })
    const nodeBin = path.join(productRoot(home), 'Runtime', 'node', 'bin')
    fs.mkdirSync(nodeBin, { recursive: true })
    fs.writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\necho "managed-node $2"\n', { mode: 0o755 })
    installManaged(home, 'codex', '#!/usr/bin/env node\n')
    return { home, env: { HOME: home, PATH: `${oldBin}:/usr/bin:/bin`, TERM: 'dumb' } }
  }

  it('finds the CLI by name in an interactive shell', async () => {
    const { home, env: shellEnv } = prepared()
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })

    const result = spawnSync('bash', ['-i', '-c', 'command -v codex; codex hello; node'], { env: shellEnv, cwd: home })

    expect(result.stdout.toString()).toBe(`${launcherDirectory(home)}/codex\nmanaged-node hello\nold-node\n`)
  })

  it('finds the CLI by name in a login shell through ~/.profile', async () => {
    const { home, env: shellEnv } = prepared()
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })

    const result = spawnSync('bash', ['-l', '-c', 'command -v codex'], { env: shellEnv, cwd: home })

    expect(result.stdout.toString()).toBe(`${launcherDirectory(home)}/codex\n`)
  })

  it('no longer finds it once the last CLI was uninstalled', async () => {
    const { home, env: shellEnv } = prepared()
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/bin/bash' })
    fs.rmSync(path.join(productRoot(home), 'Cli', 'npm', 'bin', 'codex'))
    await syncLinuxTerminalCommands({ reason: 'uninstall', env: env(home), loginShell: '/bin/bash' })

    const result = spawnSync('bash', ['-i', '-c', 'command -v codex; printf %s "$PATH"'], { env: shellEnv, cwd: home })

    // /etc/bash.bashrc may add folders of its own; ours is the one that must be gone.
    const output = result.stdout.toString()
    expect(output.endsWith(shellEnv.PATH)).toBe(true)
    expect(output).not.toContain('launchers')
  })
})

describe.runIf(process.platform === 'linux' && hasShell('zsh'))('a new zsh after the sync', () => {
  it('finds the CLI by name', async () => {
    const home = homeDirectory()
    installManaged(home, 'claude')
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/usr/bin/zsh' })

    const result = spawnSync('zsh', ['-i', '-c', 'command -v claude'], { env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, cwd: home })

    expect(result.stdout.toString()).toBe(`${launcherDirectory(home)}/claude\n`)
  })
})

describe.runIf(process.platform === 'linux' && hasShell('fish'))('a new fish after the sync', () => {
  it('finds the CLI by name', async () => {
    const home = homeDirectory()
    installManaged(home, 'claude')
    await syncLinuxTerminalCommands({ reason: 'install', env: env(home), loginShell: '/usr/bin/fish' })

    const result = spawnSync('fish', ['-i', '-c', 'command -v claude'], { env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, cwd: home })

    expect(result.stdout.toString()).toBe(`${launcherDirectory(home)}/claude\n`)
  })
})
