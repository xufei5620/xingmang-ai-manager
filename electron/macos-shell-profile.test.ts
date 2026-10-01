import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMacosShellProfileBlock,
  ensureMacosShellProfile,
  isZshLoginShell,
  macosShellProfileMarker,
  planMacosShellProfileAppend,
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

describe('isZshLoginShell', () => {
  it('accepts zsh wherever it lives and nothing else', () => {
    expect(isZshLoginShell('/bin/zsh')).toBe(true)
    expect(isZshLoginShell('/opt/homebrew/bin/zsh')).toBe(true)
    expect(isZshLoginShell('/bin/bash')).toBe(false)
    expect(isZshLoginShell('/opt/homebrew/bin/fish')).toBe(false)
    expect(isZshLoginShell(null)).toBe(false)
  })
})

describe('ensureMacosShellProfile', () => {
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

  it('does not write anything for a login shell other than zsh', async () => {
    const home = homeDirectory()

    await expect(ensureMacosShellProfile({ reason: 'install', homeDirectory: home, loginShell: '/bin/bash' })).resolves.toBe('unsupported-shell')

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
})
