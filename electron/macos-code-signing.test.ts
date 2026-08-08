import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  darwinDeveloperIdRequirement,
  darwinDeveloperIdVerificationArgv,
} from './macos-code-signing'

const openAiTeamIdentifier = '2DC432GLL2'
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('darwin Developer ID requirements', () => {
  it('pins the chain to Apple, to Developer ID, and to one team', () => {
    const requirement = darwinDeveloperIdRequirement(openAiTeamIdentifier)

    expect(requirement).toBe(
      'anchor apple generic'
      + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
      + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
      + ` and certificate leaf[subject.OU] = "${openAiTeamIdentifier}"`,
    )
  })

  it('anchors generically so third-party Developer ID chains still qualify', () => {
    // Plain `anchor apple` matches only Apple's own software and would reject every
    // vendor binary this app launches, which is the tempting wrong fix when a
    // requirement starts failing.
    expect(darwinDeveloperIdRequirement(openAiTeamIdentifier)).toContain('anchor apple generic')
  })

  it('pins the signing identifier when one is supplied', () => {
    expect(darwinDeveloperIdRequirement(openAiTeamIdentifier, {
      bundleIdentifier: 'com.openai.codex',
    })).toBe(
      'identifier "com.openai.codex"'
      + ' and anchor apple generic'
      + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
      + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
      + ` and certificate leaf[subject.OU] = "${openAiTeamIdentifier}"`,
    )
  })

  it('rejects a team or bundle identifier that could reshape the requirement', () => {
    expect(() => darwinDeveloperIdRequirement('2DC432GLL')).toThrow('team identifier')
    expect(() => darwinDeveloperIdRequirement('2dc432gll2')).toThrow('team identifier')
    expect(() => darwinDeveloperIdRequirement('" or anchor apple generic and "'))
      .toThrow('team identifier')
    expect(() => darwinDeveloperIdRequirement(openAiTeamIdentifier, {
      bundleIdentifier: 'com.openai.codex" or "',
    })).toThrow('bundle identifier')
  })

  it('builds argv whose verdict is the exit status, with the target last', () => {
    const argv = darwinDeveloperIdVerificationArgv(openAiTeamIdentifier, '/tmp/codex')

    expect(argv[0]).toBe('--verify')
    expect(argv[1]).toBe('--strict')
    expect(argv.at(-1)).toBe('/tmp/codex')
    expect(argv.filter((argument) => argument.startsWith('-R='))).toHaveLength(1)
    // `-dv` would print attacker-chosen prose that a caller might be tempted to parse.
    expect(argv).not.toContain('-dv')
    expect(argv).not.toContain('--verbose=4')
  })

  it('walks nested code only for bundles', () => {
    expect(darwinDeveloperIdVerificationArgv(openAiTeamIdentifier, '/tmp/a.app', { deep: true }))
      .toContain('--deep')
    expect(darwinDeveloperIdVerificationArgv(openAiTeamIdentifier, '/tmp/codex'))
      .not.toContain('--deep')
  })

  it('rejects a target path carrying a NUL byte', () => {
    expect(() => darwinDeveloperIdVerificationArgv(openAiTeamIdentifier, '/tmp/co\0dex'))
      .toThrow('target path')
  })

  // The defect this module exists to close: `codesign -dv` prints the signing
  // identifier verbatim, the identifier may contain newlines, and ad-hoc signing needs
  // no certificate. So an unprivileged local process could forge the exact
  // `TeamIdentifier=` and `Authority=` lines the old text match looked for. This runs
  // that attack against real codesign and asserts the requirement refuses it.
  it.runIf(process.platform === 'darwin')('refuses an ad-hoc signature that forges the team and authority lines', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codesign-forgery-'))
    temporaryDirectories.push(directory)
    const forged = path.join(directory, 'codex')
    fs.copyFileSync('/bin/echo', forged)
    execFileSync('/usr/bin/codesign', [
      '-f',
      '-s',
      '-',
      '-i',
      [
        'xingmang',
        `TeamIdentifier=${openAiTeamIdentifier}`,
        `Authority=Developer ID Application: OpenAI OpCo, LLC (${openAiTeamIdentifier})`,
      ].join('\n'),
      forged,
    ], { stdio: 'pipe' })

    // The forgery is convincing enough to satisfy the checks this module replaced.
    // codesign writes the detail block to stderr, which is why the old code combined
    // both streams before matching.
    const described = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', forged], {
      encoding: 'utf8',
    })
    const details = `${described.stdout}\n${described.stderr}`
    expect(new RegExp(`^TeamIdentifier=${openAiTeamIdentifier}$`, 'm').test(details)).toBe(true)
    expect(details).toContain(
      `Authority=Developer ID Application: OpenAI OpCo, LLC (${openAiTeamIdentifier})`,
    )

    expect(() => execFileSync(
      '/usr/bin/codesign',
      darwinDeveloperIdVerificationArgv(openAiTeamIdentifier, forged),
      { stdio: 'pipe' },
    )).toThrow()
  })

  it.runIf(process.platform === 'darwin')('refuses an unsigned executable', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codesign-unsigned-'))
    temporaryDirectories.push(directory)
    const unsigned = path.join(directory, 'codex')
    fs.copyFileSync('/bin/echo', unsigned)
    execFileSync('/usr/bin/codesign', ['--remove-signature', unsigned], { stdio: 'pipe' })

    expect(() => execFileSync(
      '/usr/bin/codesign',
      darwinDeveloperIdVerificationArgv(openAiTeamIdentifier, unsigned),
      { stdio: 'pipe' },
    )).toThrow()
  })
})
