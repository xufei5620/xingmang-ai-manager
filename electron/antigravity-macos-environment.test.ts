import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  antigravityGatewayVariableNames,
  buildAntigravityGatewayEnvironment,
  type AntigravityGatewayEnvironment,
} from './antigravity-gateway'
import {
  antigravityShellProfileMarker,
  buildAntigravityFishProfile,
  buildAntigravityFishSettingsFile,
  buildAntigravityPosixSettingsFile,
  buildAntigravityShellProfileBlock,
  parseAntigravityPosixSettingsFile,
  planAntigravityShellProfileAppend,
  readMacosAntigravityEnvironment,
  writeMacosAntigravityEnvironment,
} from './antigravity-macos-environment'

const key = 'sk-0123456789abcdefABCDEF'
const environment = buildAntigravityGatewayEnvironment({
  baseUrl: 'https://xm.solov.cc',
  apiKey: key,
  models: ['gemini-3.8-flash', 'gemini-4-argon-high'],
})

const temporaryDirectories: string[] = []

function homeDirectory(): string {
  // macOS puts the temp directory behind /var -> /private/var, which the
  // reparse-point guard would (rightly) refuse.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-agy-env-')))
  temporaryDirectories.push(directory)
  return directory
}

function settingsPath(home: string, name: 'gateway.sh' | 'gateway.fish'): string {
  return path.join(home, 'Library', 'Application Support', 'XingMangAI', 'Antigravity', name)
}

function fishProfilePath(home: string): string {
  return path.join(home, '.config', 'fish', 'conf.d', 'xingmang-ai-manager-antigravity.fish')
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

/** The system copy of the shell, else one from Homebrew (where fish usually comes from), or null. */
function findShell(name: string): string | null {
  return ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']
    .map((directory) => path.join(directory, name))
    .find((candidate) => fs.existsSync(candidate)) ?? null
}

// 每次调写入都传 env: {}：不传就读这台机器自己的 XDG_CONFIG_HOME（GitHub 的 Linux 机器上设了），
// 既找错 fish 文件夹，也可能写进开发者真的 fish 设置。
function write(home: string, loginShell: string | null, value: AntigravityGatewayEnvironment = environment, skipped?: (displayPath: string, error: unknown) => void) {
  return writeMacosAntigravityEnvironment(value, { platform: 'darwin', homeDirectory: home, loginShell, env: {}, skipped })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('the Antigravity settings files', () => {
  it('give one export line per variable for sh, bash and zsh', () => {
    const lines = buildAntigravityPosixSettingsFile(environment).split('\n')
    expect(lines[0].startsWith('# ')).toBe(true)
    expect(lines.slice(1)).toEqual([
      "export AGY_LLM_GATEWAY_URL='https://xm.solov.cc'",
      `export AGY_LLM_GATEWAY_API_KEY='${key}'`,
      "export AGY_LLM_GATEWAY_WIRE_PROTOCOL='genai'",
      "export AGY_LLM_GATEWAY_MODELS='gemini-3.8-flash,gemini-4-argon-high'",
      '',
    ])
  })

  it('give one set -gx line per variable for fish', () => {
    const lines = buildAntigravityFishSettingsFile(environment).split('\n')
    expect(lines.slice(1)).toEqual([
      "set -gx AGY_LLM_GATEWAY_URL 'https://xm.solov.cc'",
      `set -gx AGY_LLM_GATEWAY_API_KEY '${key}'`,
      "set -gx AGY_LLM_GATEWAY_WIRE_PROTOCOL 'genai'",
      "set -gx AGY_LLM_GATEWAY_MODELS 'gemini-3.8-flash,gemini-4-argon-high'",
      '',
    ])
  })

  it('refuse a missing or multi-line value', () => {
    expect(() => buildAntigravityPosixSettingsFile({ ...environment, AGY_LLM_GATEWAY_MODELS: '' }))
      .toThrow('Antigravity 的连接设置不完整')
    expect(() => buildAntigravityFishSettingsFile({ ...environment, AGY_LLM_GATEWAY_URL: 'https://xm.solov.cc\nset -gx X 1' }))
      .toThrow('Antigravity 的连接设置不完整')
  })

  it('read back only the lines written in that shape', () => {
    expect(parseAntigravityPosixSettingsFile(buildAntigravityPosixSettingsFile(environment))).toEqual(environment)
    expect(parseAntigravityPosixSettingsFile([
      "export AGY_LLM_GATEWAY_URL='https://xm.solov.cc'",
      "export AGY_LLM_GATEWAY_HEADERS='X-Team: a'",
      "export PATH='/tmp'",
      "  export AGY_LLM_GATEWAY_MODELS='a'",
      'export AGY_LLM_GATEWAY_API_KEY=$(whoami)',
    ].join('\r\n'))).toEqual({ AGY_LLM_GATEWAY_URL: 'https://xm.solov.cc' })
    expect(parseAntigravityPosixSettingsFile('')).toEqual({})
  })
})

describe('the Antigravity startup file block', () => {
  it('puts agy\'s folder last on PATH, once, and only reads the settings file when it is there', () => {
    const block = buildAntigravityShellProfileBlock()
    expect(block.startsWith(`${antigravityShellProfileMarker}\n`)).toBe(true)
    expect(block).toContain([
      'case ":$PATH:" in',
      '  *":$HOME/.local/bin:"*) ;;',
      '  *) export PATH="$PATH:$HOME/.local/bin" ;;',
      'esac',
    ].join('\n'))
    expect(block).toContain('if [ -r "$HOME/Library/Application Support/XingMangAI/Antigravity/gateway.sh" ]; then')
    expect(block).toContain('  . "$HOME/Library/Application Support/XingMangAI/Antigravity/gateway.sh"')
    expect(block).not.toContain(key)
    expect(block).not.toContain('AGY_')
    expect(block.endsWith('\n')).toBe(true)
    const fish = buildAntigravityFishProfile()
    expect(fish).toContain([
      'if not contains -- "$HOME/.local/bin" $PATH',
      '    set -gx PATH $PATH "$HOME/.local/bin"',
      'end',
    ].join('\n'))
    expect(fish).toContain('source "$HOME/Library/Application Support/XingMangAI/Antigravity/gateway.fish"')
    expect(fish).not.toContain('AGY_')
  })

  // The block alone, without a login shell's system profile in between (macOS's path_helper reorders PATH).
  it.runIf(fs.existsSync('/bin/sh'))('appends agy\'s folder once and leaves a PATH that already has it as it is', () => {
    const home = homeDirectory()
    const profile = path.join(home, 'block.sh')
    fs.writeFileSync(profile, buildAntigravityShellProfileBlock())
    function pathAfter(initial: string, times: number): string {
      const script = `${Array.from({ length: times }, () => '. "$1"').join('; ')}; printenv PATH`
      const result = spawnSync('/bin/sh', ['-c', script, 'sh', profile], { env: { HOME: home, PATH: initial }, timeout: 10_000 })
      return result.stdout.toString().trim()
    }
    expect(pathAfter('/usr/bin:/bin', 1)).toBe(`/usr/bin:/bin:${home}/.local/bin`)
    expect(pathAfter('/usr/bin:/bin', 2)).toBe(`/usr/bin:/bin:${home}/.local/bin`)
    expect(pathAfter(`${home}/.local/bin:/usr/bin:/bin`, 1)).toBe(`${home}/.local/bin:/usr/bin:/bin`)
    expect(pathAfter(`/usr/bin:${home}/.local/bin:/bin`, 2)).toBe(`/usr/bin:${home}/.local/bin:/bin`)
  })

  it('is appended once, on a line of its own', () => {
    const block = buildAntigravityShellProfileBlock()
    expect(planAntigravityShellProfileAppend(null)).toBe(block)
    expect(planAntigravityShellProfileAppend('')).toBe(block)
    expect(planAntigravityShellProfileAppend('export A=1\n')).toBe(`\n${block}`)
    expect(planAntigravityShellProfileAppend('export A=1')).toBe(`\n\n${block}`)
    expect(planAntigravityShellProfileAppend(`export A=1\n${block}`)).toBe('')
  })
})

// The writes take a POSIX home folder, as on a Mac; Windows temp folders are not one (same as macos-shell-profile.test.ts).
describe.runIf(process.platform !== 'win32')('writeMacosAntigravityEnvironment', () => {
  it('writes both settings files for the user alone and appends the block after what the user wrote', async () => {
    const home = homeDirectory()
    const own = 'export AGY_LLM_GATEWAY_HEADERS="X-Team: a"\n'
    fs.writeFileSync(path.join(home, '.zprofile'), own)

    await expect(write(home, '/bin/zsh')).resolves.toEqual({ outcome: 'written', profile: 'added' })

    for (const name of ['gateway.sh', 'gateway.fish'] as const) {
      expect(fs.statSync(settingsPath(home, name)).mode & 0o777).toBe(0o600)
    }
    expect(fs.readFileSync(settingsPath(home, 'gateway.sh'), 'utf8')).toBe(buildAntigravityPosixSettingsFile(environment))
    expect(fs.readFileSync(settingsPath(home, 'gateway.fish'), 'utf8')).toBe(buildAntigravityFishSettingsFile(environment))
    const profile = fs.readFileSync(path.join(home, '.zprofile'), 'utf8')
    expect(profile).toBe(`${own}\n${buildAntigravityShellProfileBlock()}`)
    expect(profile).not.toContain(key)
  })

  it('answers unchanged when nothing differs, and rewrites only the settings when the menu changes', async () => {
    const home = homeDirectory()
    await write(home, '/bin/zsh')
    const before = fs.statSync(settingsPath(home, 'gateway.sh')).mtimeMs

    await expect(write(home, '/bin/zsh')).resolves.toEqual({ outcome: 'unchanged', profile: 'present' })
    expect(fs.statSync(settingsPath(home, 'gateway.sh')).mtimeMs).toBe(before)

    const changed = { ...environment, AGY_LLM_GATEWAY_MODELS: 'gemini-3.8-flash,gemini-4-hydrogen' }
    await expect(write(home, '/bin/zsh', changed)).resolves.toEqual({ outcome: 'written', profile: 'present' })
    expect(parseAntigravityPosixSettingsFile(fs.readFileSync(settingsPath(home, 'gateway.sh'), 'utf8'))).toEqual(changed)
    expect(count(fs.readFileSync(path.join(home, '.zprofile'), 'utf8'), antigravityShellProfileMarker)).toBe(1)
  })

  it('puts the block back when the user removed it but the settings did not change', async () => {
    const home = homeDirectory()
    await write(home, '/bin/zsh')
    fs.writeFileSync(path.join(home, '.zprofile'), 'export A=1\n')

    await expect(write(home, '/bin/zsh')).resolves.toEqual({ outcome: 'written', profile: 'added' })
    expect(fs.readFileSync(path.join(home, '.zprofile'), 'utf8')).toBe(`export A=1\n\n${buildAntigravityShellProfileBlock()}`)
  })

  it('goes into the login file bash stops at', async () => {
    const home = homeDirectory()
    fs.writeFileSync(path.join(home, '.bash_profile'), 'export A=1\n')
    fs.writeFileSync(path.join(home, '.profile'), 'export B=1\n')

    await write(home, '/bin/bash')

    expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toContain(antigravityShellProfileMarker)
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe('export B=1\n')
    expect(fs.existsSync(path.join(home, '.zprofile'))).toBe(false)
  })

  it('gives fish a conf.d file of its own, and a zsh account that also has fish one as well', async () => {
    const fishHome = homeDirectory()
    await expect(write(fishHome, '/opt/homebrew/bin/fish')).resolves.toEqual({ outcome: 'written', profile: 'added' })
    expect(fs.readFileSync(fishProfilePath(fishHome), 'utf8')).toBe(buildAntigravityFishProfile())
    expect(fs.existsSync(path.join(fishHome, '.zprofile'))).toBe(false)

    const bothHome = homeDirectory()
    fs.mkdirSync(path.join(bothHome, '.config', 'fish'), { recursive: true })
    await write(bothHome, '/bin/zsh')
    expect(fs.readFileSync(path.join(bothHome, '.zprofile'), 'utf8')).toContain(antigravityShellProfileMarker)
    expect(fs.readFileSync(fishProfilePath(bothHome), 'utf8')).toBe(buildAntigravityFishProfile())

    // The terminal-commands file next to it is a different file, so the two never collide.
    expect(fs.readdirSync(path.dirname(fishProfilePath(bothHome)))).toEqual(['xingmang-ai-manager-antigravity.fish'])
  })

  it('reports a fish file it could not write without failing the call', async () => {
    const home = homeDirectory()
    fs.mkdirSync(path.dirname(fishProfilePath(home)), { recursive: true })
    fs.writeFileSync(fishProfilePath(home), 'set -gx A 1\n')
    const skipped: string[] = []

    await expect(write(home, '/bin/zsh', environment, (displayPath) => skipped.push(displayPath)))
      .resolves.toEqual({ outcome: 'written', profile: 'added' })
    expect(skipped).toEqual(['fish/conf.d/xingmang-ai-manager-antigravity.fish'])
    expect(fs.readFileSync(fishProfilePath(home), 'utf8')).toBe('set -gx A 1\n')
  })

  it('writes the settings but leaves the startup files alone for a shell it does not handle', async () => {
    const home = homeDirectory()
    await expect(write(home, '/bin/tcsh')).resolves.toEqual({ outcome: 'written', profile: 'unsupported-shell' })
    expect(fs.existsSync(settingsPath(home, 'gateway.sh'))).toBe(true)
    expect(fs.readdirSync(home)).toEqual(['Library'])
  })

  it.runIf(process.platform !== 'win32')('refuses a startup file that is a link instead of following it', async () => {
    const home = homeDirectory()
    const dotfiles = path.join(home, 'dotfiles-zprofile')
    fs.writeFileSync(dotfiles, 'export A=1\n')
    fs.symlinkSync(dotfiles, path.join(home, '.zprofile'))

    await expect(write(home, '/bin/zsh')).rejects.toThrow()
    expect(fs.readFileSync(dotfiles, 'utf8')).toBe('export A=1\n')
  })

  it('writes nothing at all for an incomplete environment', async () => {
    const home = homeDirectory()
    await expect(write(home, '/bin/zsh', { ...environment, AGY_LLM_GATEWAY_API_KEY: '' }))
      .rejects.toThrow('Antigravity 的连接设置不完整，未作任何修改')
    expect(fs.readdirSync(home)).toEqual([])
  })

})

describe('the macOS-only guard', () => {
  it('runs only on macOS', async () => {
    await expect(writeMacosAntigravityEnvironment(environment, { platform: 'win32', homeDirectory: homeDirectory() }))
      .rejects.toThrow('只有 macOS 上')
    await expect(readMacosAntigravityEnvironment({ platform: 'linux', homeDirectory: homeDirectory() }))
      .rejects.toThrow('只有 macOS 上')
  })
})

describe.runIf(process.platform !== 'win32')('readMacosAntigravityEnvironment', () => {
  it('reads nothing before the first write and the four values after it', async () => {
    const home = homeDirectory()
    await expect(readMacosAntigravityEnvironment({ platform: 'darwin', homeDirectory: home })).resolves.toEqual({})
    await write(home, '/bin/zsh')
    await expect(readMacosAntigravityEnvironment({ platform: 'darwin', homeDirectory: home })).resolves.toEqual(environment)
  })
})

// The promise itself: a new Terminal window, which starts a login shell, sees
// the four values. Each shell runs wherever it is installed (CI's macOS runner
// has zsh and bash).
describe.runIf(process.platform !== 'win32')('a new login shell after the write', () => {
  const zsh = findShell('zsh')
  const bash = findShell('bash')
  const fish = findShell('fish')
  const printAll = antigravityGatewayVariableNames.map((name) => `printenv ${name}`).join('; ')
  const expected = `${antigravityGatewayVariableNames.map((name) => environment[name]).join('\n')}\n`

  function runLoginShell(shell: string, home: string, command: string): { stdout: string; stderr: string } {
    // A login shell that hangs must fail the test, not stall the run: spawnSync blocks vitest's own timeout.
    const result = spawnSync(shell, ['-l', '-c', command], {
      env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
      cwd: home,
      timeout: 10_000,
    })
    if (result.error) throw result.error
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  // The machine's own /etc/profile may put its folders in front (CI images do), so only the end is ours to check.
  function agyFolderEntries(pathValue: string, home: string): { count: number; last: boolean } {
    const entries = pathValue.trim().split(':')
    const folder = `${home}/.local/bin`
    return { count: entries.filter((entry) => entry === folder).length, last: entries.at(-1) === folder }
  }

  it.runIf(zsh !== null)('zsh sees the four values', async () => {
    const home = homeDirectory()
    await write(home, '/bin/zsh')
    const { stdout, stderr } = runLoginShell(zsh ?? '', home, printAll)
    expect(stdout, stderr).toBe(expected)
  })

  it.runIf(zsh !== null)('zsh finds agy\'s folder last on PATH, listed once even in a nested login shell', async () => {
    const home = homeDirectory()
    await write(home, '/bin/zsh')
    const once = runLoginShell(zsh ?? '', home, 'printenv PATH')
    expect(agyFolderEntries(once.stdout, home), once.stderr).toEqual({ count: 1, last: true })
    const nested = runLoginShell(zsh ?? '', home, `${zsh} -l -c 'printenv PATH'`)
    expect(agyFolderEntries(nested.stdout, home), nested.stderr).toEqual({ count: 1, last: true })
  })

  it.runIf(bash !== null)('bash sees the four values, and nothing breaks once the settings file is gone', async () => {
    const home = homeDirectory()
    await write(home, '/bin/bash')
    const found = runLoginShell(bash ?? '', home, printAll)
    expect(found.stdout, found.stderr).toBe(expected)

    fs.rmSync(settingsPath(home, 'gateway.sh'))
    const gone = runLoginShell(bash ?? '', home, 'printenv AGY_LLM_GATEWAY_URL; echo ok')
    expect(gone.stdout, gone.stderr).toBe('ok\n')
    expect(gone.stderr).toBe('')
  })

  it.runIf(bash !== null)('bash puts agy\'s folder last on PATH, and never lists it twice', async () => {
    const home = homeDirectory()
    await write(home, '/bin/bash')
    const added = runLoginShell(bash ?? '', home, 'printenv PATH')
    expect(agyFolderEntries(added.stdout, home), added.stderr).toEqual({ count: 1, last: true })
    const nested = runLoginShell(bash ?? '', home, `${bash} -l -c 'printenv PATH'`)
    expect(agyFolderEntries(nested.stdout, home), nested.stderr).toEqual({ count: 1, last: true })
    // Where an inherited entry ends up is the system's call: macOS's /etc/profile runs path_helper, which puts
    // its own folders first. Ours only must not add it again; that the block leaves it in place is checked
    // on the block alone, above.
    const already = spawnSync(bash ?? '', ['-l', '-c', 'printenv PATH'], {
      env: { HOME: home, PATH: `${home}/.local/bin:/usr/bin:/bin`, TERM: 'dumb' },
      cwd: home,
      timeout: 10_000,
    })
    expect(agyFolderEntries(already.stdout.toString(), home).count, already.stderr.toString()).toBe(1)
  })

  it.runIf(fish !== null)('fish sees the four values and agy\'s folder last on PATH', async () => {
    const home = homeDirectory()
    await write(home, '/opt/homebrew/bin/fish')
    const { stdout, stderr } = runLoginShell(fish ?? '', home, printAll)
    expect(stdout, stderr).toBe(expected)
    const found = runLoginShell(fish ?? '', home, 'string join : $PATH')
    expect(agyFolderEntries(found.stdout, home), found.stderr).toEqual({ count: 1, last: true })
  })
})

describe('antigravity-macos-environment with random inputs', () => {
  const value = fc.string({ minLength: 1, maxLength: 30 }).filter((text) => !/[\0\r\n]/.test(text))
  const randomEnvironment = fc.record({
    AGY_LLM_GATEWAY_URL: value,
    AGY_LLM_GATEWAY_API_KEY: value,
    AGY_LLM_GATEWAY_WIRE_PROTOCOL: value,
    AGY_LLM_GATEWAY_MODELS: value,
  })

  it('keeps every value on its own line, whatever it holds', () => {
    fc.assert(fc.property(randomEnvironment, (random) => {
      for (const file of [buildAntigravityPosixSettingsFile(random), buildAntigravityFishSettingsFile(random)]) {
        const lines = file.split('\n')
        expect(lines).toHaveLength(antigravityGatewayVariableNames.length + 2)
        antigravityGatewayVariableNames.forEach((name, index) => {
          expect(lines[index + 1]).toMatch(new RegExp(`^(export ${name}=|set -gx ${name} )'`))
        })
      }
    }))
  })

  it.runIf(fs.existsSync('/bin/sh'))('hands sh back exactly the values it was given, whatever they hold', () => {
    fc.assert(fc.property(randomEnvironment, (random) => {
      const file = path.join(homeDirectory(), 'gateway.sh')
      fs.writeFileSync(file, buildAntigravityPosixSettingsFile(random))
      const script = `. "$1"; ${antigravityGatewayVariableNames.map((name) => `printf '%s\\0' "$${name}"`).join('; ')}`
      const result = spawnSync('/bin/sh', ['-c', script, 'sh', file], { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 })
      expect(result.stdout.toString().split('\0').slice(0, -1)).toEqual(antigravityGatewayVariableNames.map((name) => random[name]))
    }), { numRuns: 40 })
  })

  it('reads back exactly what it wrote for any settings the gateway builder can give', () => {
    const model = fc.oneof(fc.constantFrom('gemini-3.8-flash', 'gemini-4-argon'), fc.string({ maxLength: 20 }))
    fc.assert(fc.property(fc.string({ maxLength: 40 }), fc.array(model, { maxLength: 6 }), (apiKey, models) => {
      let built: AntigravityGatewayEnvironment
      try {
        built = buildAntigravityGatewayEnvironment({ baseUrl: 'https://xm.solov.cc', apiKey, models })
      } catch {
        return
      }
      expect(parseAntigravityPosixSettingsFile(buildAntigravityPosixSettingsFile(built))).toEqual(built)
    }))
  })
})
