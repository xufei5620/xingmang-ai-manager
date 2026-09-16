import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it } from 'vitest'
import { runCodexContextLimitsMigration } from './codex-config-migration'
import { codexConfigSnapshotPaths } from './config-files'
import type { ProviderConfigRoots } from './codex-home'

const temporaryDirectories: string[] = []

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-migration-test-'))
  temporaryDirectories.push(directory)
  const userHome = path.join(directory, 'home')
  const roots: ProviderConfigRoots = { userHome, codexHome: path.join(userHome, '.codex') }
  const managerDataDirectory = path.join(directory, 'manager-data')
  fs.mkdirSync(managerDataDirectory, { recursive: true })
  return { directory, roots, managerDataDirectory, paths: codexConfigSnapshotPaths(roots) }
}

function writeConfig(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function readConfig(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

const oldDefaults = 'model_context_window = 1_000_000\nmodel_auto_compact_token_limit = 900000\n'

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('one-time Codex context limit migration', () => {
  it('removes both root settings from active and source snapshots, with exact backups and other settings intact', async () => {
    const { roots, managerDataDirectory, paths } = fixture()
    const originals = new Map<string, string>()
    for (const [source, filePath] of Object.entries(paths)) {
      const original = [
        '# 用户配置',
        `model = "${source}-custom-model"`,
        oldDefaults.trimEnd(),
        'model_reasoning_effort = "high"',
        '[profiles.custom]',
        'model_context_window = 250000',
        'model_auto_compact_token_limit = 200000',
        '[features]',
        'goals = true',
        '',
      ].join('\n')
      originals.set(filePath, original)
      writeConfig(filePath, original)
    }
    const authPath = path.join(roots.codexHome, 'auth.json')
    const authContent = '{"OPENAI_API_KEY":"sk-migration-test-fixture"}\n'
    writeConfig(authPath, authContent)

    const result = await runCodexContextLimitsMigration(managerDataDirectory, roots)

    expect(result.skipped).toBe(false)
    expect(result.files.slice().sort()).toEqual(Object.values(paths).sort())
    expect(result.backups).toHaveLength(3)
    for (const [filePath, original] of originals) {
      const before = TOML.parse(original)
      delete before.model_context_window
      delete before.model_auto_compact_token_limit
      expect(TOML.parse(readConfig(filePath))).toEqual(before)
      const backup = result.backups.find((candidate) => candidate.startsWith(`${filePath}.bak.`))
      expect(backup).toBeDefined()
      expect(readConfig(backup!)).toBe(original)
    }
    expect(readConfig(authPath)).toBe(authContent)
  })

  it('skips subsequent launches even after the user re-adds limits or makes the config unparseable', async () => {
    const { roots, managerDataDirectory, paths } = fixture()
    writeConfig(paths.active, `${oldDefaults}model = "custom"\n`)
    await runCodexContextLimitsMigration(managerDataDirectory, roots)

    const edited = `${oldDefaults}model = "user-added"\n`
    writeConfig(paths.active, edited)
    expect(await runCodexContextLimitsMigration(managerDataDirectory, roots)).toEqual({
      skipped: true, files: [], backups: [],
    })
    expect(readConfig(paths.active)).toBe(edited)

    const invalid = `${oldDefaults}model = "unterminated\n`
    writeConfig(paths.active, invalid)
    expect(await runCodexContextLimitsMigration(managerDataDirectory, roots)).toEqual({
      skipped: true, files: [], backups: [],
    })
    expect(readConfig(paths.active)).toBe(invalid)
  })

  it('marks an absent config as checked without creating the Codex directory', async () => {
    const { roots, managerDataDirectory, paths } = fixture()

    expect(await runCodexContextLimitsMigration(managerDataDirectory, roots)).toEqual({
      skipped: false, files: [], backups: [],
    })
    expect(fs.existsSync(roots.codexHome)).toBe(false)

    writeConfig(paths.active, oldDefaults)
    expect((await runCodexContextLimitsMigration(managerDataDirectory, roots)).skipped).toBe(true)
    expect(readConfig(paths.active)).toBe(oldDefaults)
  })

  it.each([
    ['model_context_window', 250000],
    ['model_auto_compact_token_limit', 123456],
  ])('removes an individually present %s even with a custom value', async (key, value) => {
    const { roots, managerDataDirectory, paths } = fixture()
    writeConfig(paths.active, `${key} = ${value}\nmodel = "custom"\n`)

    const result = await runCodexContextLimitsMigration(managerDataDirectory, roots)

    expect(result.files).toEqual([paths.active])
    expect(result.backups).toHaveLength(1)
    expect(TOML.parse(readConfig(paths.active))).toEqual({ model: 'custom' })
    expect(fs.existsSync(paths.chatgpt)).toBe(false)
    expect(fs.existsSync(paths.relay)).toBe(false)
  })

  it('leaves a config with no root limits byte-for-byte unchanged and records completion', async () => {
    const { roots, managerDataDirectory, paths } = fixture()
    const original = '# 用户注释\r\nmodel = "custom"\r\n[profiles.custom]\r\nmodel_context_window = 123456\r\n'
    writeConfig(paths.active, original)

    expect(await runCodexContextLimitsMigration(managerDataDirectory, roots)).toEqual({
      skipped: false, files: [], backups: [],
    })
    expect(readConfig(paths.active)).toBe(original)
    expect(fs.readdirSync(roots.codexHome)).toEqual(['config.toml'])
    expect((await runCodexContextLimitsMigration(managerDataDirectory, roots)).skipped).toBe(true)
  })

  it.each(['active', 'chatgpt', 'relay'] as const)(
    'preserves every file when the %s config is invalid and retries after repair',
    async (invalidSource) => {
      const { roots, managerDataDirectory, paths } = fixture()
      for (const filePath of Object.values(paths)) writeConfig(filePath, oldDefaults)
      writeConfig(paths[invalidSource], `${oldDefaults}model = "unterminated\n`)
      const before = new Map(Object.values(paths).map((filePath) => [filePath, readConfig(filePath)]))
      const filenamesBefore = fs.readdirSync(roots.codexHome).sort()

      await expect(runCodexContextLimitsMigration(managerDataDirectory, roots)).rejects.toThrow()

      for (const [filePath, content] of before) expect(readConfig(filePath)).toBe(content)
      expect(fs.readdirSync(roots.codexHome).sort()).toEqual(filenamesBefore)
      writeConfig(paths[invalidSource], oldDefaults)
      const retried = await runCodexContextLimitsMigration(managerDataDirectory, roots)
      expect(retried.skipped).toBe(false)
      expect(retried.files).toHaveLength(3)
      for (const filePath of Object.values(paths)) expect(TOML.parse(readConfig(filePath))).toEqual({})
    },
  )

  it('rolls back all replacements when the second file fails and retries without a completion marker', async () => {
    const { roots, managerDataDirectory, paths } = fixture()
    for (const filePath of Object.values(paths)) writeConfig(filePath, oldDefaults)
    const replacedIndexes: number[] = []

    await expect(runCodexContextLimitsMigration(managerDataDirectory, roots, {
      beforeReplace: (_filePath, index) => {
        replacedIndexes.push(index)
        if (index === 1) throw new Error('simulated second replacement failure')
      },
    })).rejects.toThrow('simulated second replacement failure')

    expect(replacedIndexes).toEqual([0, 1])
    for (const filePath of Object.values(paths)) expect(readConfig(filePath)).toBe(oldDefaults)
    expect(fs.readdirSync(roots.codexHome).filter((filename) => filename.endsWith('.tmp'))).toEqual([])

    const retried = await runCodexContextLimitsMigration(managerDataDirectory, roots)
    expect(retried.skipped).toBe(false)
    expect(retried.files).toHaveLength(3)
    for (const filePath of Object.values(paths)) expect(TOML.parse(readConfig(filePath))).toEqual({})
    expect((await runCodexContextLimitsMigration(managerDataDirectory, roots)).skipped).toBe(true)
  })

  it('tracks completion per resolved Codex home without consuming another root migration', async () => {
    const { directory, roots, managerDataDirectory, paths } = fixture()
    const customRoots = { ...roots, codexHome: path.join(directory, 'custom-codex') }
    const customPaths = codexConfigSnapshotPaths(customRoots)
    writeConfig(paths.active, oldDefaults)
    writeConfig(customPaths.active, oldDefaults)

    const custom = await runCodexContextLimitsMigration(managerDataDirectory, customRoots)

    expect(custom.files).toEqual([customPaths.active])
    expect(readConfig(paths.active)).toBe(oldDefaults)
    expect(TOML.parse(readConfig(customPaths.active))).toEqual({})
    const defaultRoot = await runCodexContextLimitsMigration(managerDataDirectory, roots)
    expect(defaultRoot.skipped).toBe(false)
    expect(defaultRoot.files).toEqual([paths.active])
    expect(TOML.parse(readConfig(paths.active))).toEqual({})
    const equivalentCustomRoots = { ...customRoots, codexHome: path.join(customRoots.codexHome, 'child', '..') }
    expect((await runCodexContextLimitsMigration(managerDataDirectory, equivalentCustomRoots)).skipped).toBe(true)
  })

  it('rejects an oversized source snapshot before changing any configuration and can retry after repair', async () => {
    const { roots, managerDataDirectory, paths } = fixture()
    writeConfig(paths.active, oldDefaults)
    const oversized = `${oldDefaults}#${'x'.repeat(2 * 1024 * 1024)}\n`
    writeConfig(paths.relay, oversized)

    await expect(runCodexContextLimitsMigration(managerDataDirectory, roots)).rejects.toThrow('安全上限')

    expect(readConfig(paths.active)).toBe(oldDefaults)
    expect(readConfig(paths.relay)).toBe(oversized)
    expect(fs.readdirSync(roots.codexHome).sort()).toEqual([
      path.basename(paths.active), path.basename(paths.relay),
    ].sort())
    writeConfig(paths.relay, oldDefaults)
    expect((await runCodexContextLimitsMigration(managerDataDirectory, roots)).files).toHaveLength(2)
  })

  it('refuses a linked Codex directory without touching its target or consuming the migration', async () => {
    const { directory, roots, managerDataDirectory, paths } = fixture()
    const externalDirectory = path.join(directory, 'external-codex')
    const externalConfig = path.join(externalDirectory, 'config.toml')
    writeConfig(externalConfig, oldDefaults)
    fs.mkdirSync(roots.userHome, { recursive: true })
    fs.symlinkSync(externalDirectory, roots.codexHome, 'junction')

    await expect(runCodexContextLimitsMigration(managerDataDirectory, roots)).rejects.toThrow()

    expect(readConfig(externalConfig)).toBe(oldDefaults)
    expect(fs.readdirSync(externalDirectory)).toEqual(['config.toml'])
    fs.unlinkSync(roots.codexHome)
    writeConfig(paths.active, oldDefaults)
    expect((await runCodexContextLimitsMigration(managerDataDirectory, roots)).skipped).toBe(false)
    expect(TOML.parse(readConfig(paths.active))).toEqual({})
    expect(readConfig(externalConfig)).toBe(oldDefaults)
  })
})
